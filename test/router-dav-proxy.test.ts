import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRouteCacheL1, MAX_PROBE_CANDIDATES, PROBE_AUTHORIZATION } from '@durable-dav-router/backend-services/router';
import { KvCache } from '@durable-dav-router/backend-runtime/kv';
import { registerRouterDavProxyRoutes } from '../apps/api/src/workers/routes/RouterDavProxyRoutes';

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

interface BackendSeed {
  id: string;
  owner_email: string;
  slug: string;
  base_url: string;
  backend_username?: string | null;
}

function toRow(b: BackendSeed): Record<string, unknown> {
  return {
    id: b.id,
    owner_email: b.owner_email,
    slug: b.slug,
    slug_ci: b.slug.toLowerCase(),
    base_url: b.base_url,
    display_name: null,
    created_at: 1,
    updated_at: 1,
    last_seen_at: null,
    last_status: null,
    backend_username: b.backend_username ?? null,
    backend_username_ci: b.backend_username ? b.backend_username.toLowerCase() : null,
  };
}

function fakeDb(opts: { backends: BackendSeed[] }) {
  return {
    prepare(query: string) {
      const state: { sql: string; values: unknown[] } = { sql: query, values: [] };
      const stmt = {
        bind(...values: unknown[]) {
          state.values = values;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          // Primary-key lookup, used to revalidate a cached owner→backend route
          // against the authoritative row before forwarding.
          if (state.sql.includes('FROM router_backends WHERE id = ?')) {
            const id = String(state.values[0]);
            const hit = opts.backends.find((b) => b.id === id);
            return (hit ? (toRow(hit) as T) : null);
          }
          return null as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (state.sql.includes('FROM router_backends WHERE backend_username_ci')) {
            const ci = String(state.values[0]).toLowerCase();
            const results = opts.backends.filter((b) => (b.backend_username ?? '').toLowerCase() === ci).map(toRow);
            return { results: results as T[] };
          }
          return { results: [] as T[] };
        },
        async run(): Promise<{ success: boolean }> {
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

function stubApp() {
  const routes = new Map<string, (c: never) => Promise<Response>>();
  const app = {
    on: (_methods: unknown, path: string, handler: (c: never) => Promise<Response>) => {
      routes.set(`ON ${path}`, handler);
    },
    all: (path: string, handler: (c: never) => Promise<Response>) => {
      routes.set(`ALL ${path}`, handler);
    },
  };
  return { app, routes };
}

function fakeContext(opts: {
  method?: string;
  url: string;
  env: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: string;
  params?: Record<string, string>;
}) {
  const raw = new Request(opts.url, {
    method: opts.method ?? 'PROPFIND',
    headers: new Headers(opts.headers ?? {}),
    body: opts.body,
    // @ts-expect-error duplex for Node fetch
    duplex: opts.body ? 'half' : undefined,
  });
  return {
    req: {
      raw,
      url: opts.url,
      param: (n: string) => opts.params?.[n],
      query: (k: string) => new URL(opts.url).searchParams.get(k) ?? undefined,
      header: (k: string) => raw.headers.get(k) ?? undefined,
    },
    env: opts.env,
    get: (_k: string) => '',
  };
}

const BACKENDS_TWO: BackendSeed[] = [
  { id: '1', owner_email: 'o@example.com', slug: 'a', base_url: 'https://a.example.com', backend_username: 'owner' },
  { id: '2', owner_email: 'other@example.com', slug: 'b', base_url: 'https://b.example.com', backend_username: 'owner' },
];

/** Fetch stub where volume-root `PROPFIND Depth: 0` probes get per-origin statuses. */
function stubFetchWithProbes(probeStatusByOrigin: Record<string, number>, forwardStatus = 207) {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
      calls.push({ url, init: init ?? {} });
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      const isProbe =
        (init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0' && !url.includes('/folder');
      if (isProbe) {
        const origin = new URL(url).origin;
        const status = probeStatusByOrigin[origin] ?? 404;
        return new Response(status === 207 ? '<ok/>' : 'probe', { status });
      }
      const status = forwardStatus;
      const noBody = status === 204 || status === 205 || status === 304;
      return new Response(noBody ? null : status === 401 ? 'unauthorized' : '<ok/>', {
        status,
        headers:
          status === 207
            ? { 'Content-Type': 'application/xml', DAV: '1, 2', 'MS-Author-Via': 'DAV' }
            : { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="backend"' },
      });
    },
  );
  return calls;
}

describe('RouterDavProxyRoutes owner routing', () => {
  beforeEach(() => {
    clearRouteCacheL1();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearRouteCacheL1();
  });

  it('returns 404 (not 401) for unknown owners without Access identity', async () => {
    const calls = stubFetchWithProbes({});
    const db = fakeDb({ backends: [] });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume');
    expect(handler).toBeDefined();
    const res = await handler!(
      fakeContext({
        url: 'https://router.example.com/ghost/vol',
        env: { DB: db },
        params: { owner: 'ghost', volume: 'vol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('proxies single-backend owner requests without Access identity', async () => {
    const calls = stubFetchWithProbes({});
    const db = fakeDb({
      backends: [{ id: '1', owner_email: 'starfish@example.com', slug: 'solo', base_url: 'https://backend.example.com', backend_username: 'Starfish' }],
    });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume');
    const res = await handler!(
      fakeContext({
        url: 'https://router.example.com/Starfish/test123',
        env: { DB: db },
        params: { owner: 'Starfish', volume: 'test123' },
        headers: { Authorization: 'Basic eA==', Cookie: 'CF_Authorization=abc', Depth: '1' },
      }) as never,
    );
    expect(res.status).toBe(207);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://backend.example.com/Starfish/test123');
    const headers = calls[0].init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Basic eA==');
    expect(headers.get('Cookie')).toBe('CF_Authorization=abc');
    expect(headers.get('Depth')).toBe('1');
    expect(calls[0].init.redirect).toBe('manual');
    expect(res.headers.get('DAV')).toBe('1, 2');
    expect(res.headers.get('MS-Author-Via')).toBe('DAV');
  });

  it('strips ?backend= and preserves trailing slash on collections', async () => {
    stubFetchWithProbes({});
    const db = fakeDb({
      backends: [{ id: '1', owner_email: 'starfish@example.com', slug: 'solo', base_url: 'https://backend.example.com', backend_username: 'starfish' }],
    });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume/*');
    const rawPath = '/starfish/vol/folder%20a/';
    const fullUrl = `https://router.example.com${rawPath}?backend=solo&foo=1`;
    const res = await handler!(
      {
        ...fakeContext({
          url: fullUrl,
          env: { DB: db },
          params: { owner: 'starfish', volume: 'vol' },
          headers: { Authorization: 'Basic eA==' },
        }),
        req: {
          raw: new Request(fullUrl, { method: 'PROPFIND', headers: { Authorization: 'Basic eA==' } }),
          url: fullUrl,
          param: (n: string) => ({ owner: 'starfish', volume: 'vol' })[n],
          query: (k: string) => new URL(fullUrl).searchParams.get(k) ?? undefined,
          header: (k: string) => new Request(fullUrl, { method: 'PROPFIND', headers: { Authorization: 'Basic eA==' } }).headers.get(k) ?? undefined,
        },
      } as never,
    );
    expect(res.status).toBe(207);
  });

  it('auto-routes unique volumes without a selector', async () => {
    const calls = stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 207 });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/vol',
        env: { DB: db },
        params: { owner: 'owner', volume: 'vol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(res.status).toBe(207);
    // Two volume-root probes + one forward to the unique owner.
    expect(calls.filter((c) => new Headers(c.init.headers as HeadersInit).get('Depth') === '0')).toHaveLength(2);
    expect(calls.at(-1)?.url).toBe('https://b.example.com/owner/vol');
  });

  it('returns 404 when no backend owns the volume', async () => {
    stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 404 });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/missing',
        env: { DB: db },
        params: { owner: 'owner', volume: 'missing' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 without slug enumeration on true collisions', async () => {
    const calls = stubFetchWithProbes({ 'https://a.example.com': 207, 'https://b.example.com': 207 });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/vol',
        env: { DB: db },
        params: { owner: 'owner', volume: 'vol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { backends?: unknown };
    expect(body.backends).toBeUndefined();
    // Only probes ran; nothing was forwarded.
    expect(calls.every((c) => new Headers(c.init.headers as HeadersInit).get('Depth') === '0')).toBe(true);
  });

  it('routes lone auth-gated candidates so backends return real 401s', async () => {
    const calls = stubFetchWithProbes({ 'https://a.example.com': 401, 'https://b.example.com': 404 }, 401);
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/private',
        env: { DB: db },
        params: { owner: 'owner', volume: 'private' },
        headers: { Authorization: 'Basic bad' },
      }) as never,
    );
    expect(res.status).toBe(401);
    expect(calls.at(-1)?.url).toBe('https://a.example.com/owner/private');
  });

  it('returns 502 when all probes are indeterminate', async () => {
    stubFetchWithProbes({ 'https://a.example.com': 500, 'https://b.example.com': 500 });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/vol',
        env: { DB: db },
        params: { owner: 'owner', volume: 'vol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(res.status).toBe(502);
  });

  it('still requires a selector to create brand-new top-level volumes', async () => {
    // MKCOL for a volume no backend has: probes all miss → 409, not silent
    // creation on an arbitrary backend.
    stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 404 });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        method: 'MKCOL',
        url: 'https://router.example.com/owner/newvol',
        env: { DB: db },
        params: { owner: 'owner', volume: 'newvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    // Volume-root probe misses everywhere → router reports Not Found; the
    // dashboard create flow (`POST /user/volumes?backend=`) stays explicit.
    expect([404, 409]).toContain(res.status);
  });
});

// In-memory fake of the single CACHE binding (structural KvNamespaceLike).
function makeFakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get(key: string): Promise<string | null> {
      return Promise.resolve(store.has(key) ? (store.get(key) as string) : null);
    },
    put(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(store.delete(key));
    },
    list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      return Promise.resolve({
        keys: [...store.keys()].filter((name) => name.startsWith(options.prefix)).map((name) => ({ name })),
        list_complete: true,
      });
    },
  };
}

function probeCount(calls: CapturedFetch[]): number {
  return calls.filter((c) => new Headers(c.init.headers as HeadersInit).get('Depth') === '0').length;
}

describe('RouterDavProxyRoutes KV route cache', () => {
  beforeEach(() => {
    clearRouteCacheL1();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearRouteCacheL1();
  });

  it('serves repeat bare requests from cache without re-probing', async () => {
    const calls = stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 207 });
    const kv = makeFakeKv();
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume')!;
    const ctx = () =>
      fakeContext({
        url: 'https://router.example.com/owner/cachedvol',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'cachedvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never;
    const first = await handler(ctx());
    expect(first.status).toBe(207);
    expect(probeCount(calls)).toBe(2);
    expect([...kv.store.keys()].some((k) => k.startsWith('davRoute:'))).toBe(true);
    const second = await handler(ctx());
    expect(second.status).toBe(207);
    // Cache hit: one more forward, zero new probes.
    expect(probeCount(calls)).toBe(2);
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)?.url).toBe('https://b.example.com/owner/cachedvol');
  });

  it('works without a CACHE binding (fail-soft probe path)', async () => {
    const calls = stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 207 });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume')!;
    const res = await handler(
      fakeContext({
        url: 'https://router.example.com/owner/nocachevol',
        env: { DB: db },
        params: { owner: 'owner', volume: 'nocachevol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(res.status).toBe(207);
    expect(probeCount(calls)).toBe(2);
  });

  it('explicit selectors bypass the cached route and never overwrite it', async () => {
    const calls = stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 207 });
    const kv = makeFakeKv();
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume')!;
    const bare = await handler(
      fakeContext({
        url: 'https://router.example.com/owner/selvol',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'selvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(bare.status).toBe(207);
    expect(calls.at(-1)?.url).toBe('https://b.example.com/owner/selvol');
    const probesBefore = probeCount(calls);
    const explicit = await handler(
      fakeContext({
        url: 'https://router.example.com/owner/selvol?backend=a',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'selvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(explicit.status).toBe(207);
    expect(calls.at(-1)?.url).toBe('https://a.example.com/owner/selvol');
    // Explicit path never probes …
    expect(probeCount(calls)).toBe(probesBefore);
    // … and the bare default still resolves to the probed owner.
    const again = await handler(
      fakeContext({
        url: 'https://router.example.com/owner/selvol',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'selvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(again.status).toBe(207);
    expect(calls.at(-1)?.url).toBe('https://b.example.com/owner/selvol');
    expect(probeCount(calls)).toBe(probesBefore);
  });

  it('stale hits self-heal: forward 404 evicts and re-resolves', async () => {
    const calls: CapturedFetch[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
        calls.push({ url, init: init ?? {} });
        const headers = new Headers((init?.headers ?? {}) as HeadersInit);
        const isProbe = (init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0';
        if (isProbe) {
          // Volume moved from b to a between requests.
          return new Response('probe', { status: url.startsWith('https://a.example.com') ? 207 : 404 });
        }
        // Forward to the stale backend 404s; the new owner serves.
        return new Response(url.startsWith('https://b.example.com') ? 'gone' : '<ok/>', {
          status: url.startsWith('https://b.example.com') ? 404 : 207,
        });
      },
    );
    const kv = makeFakeKv();
    // Seed the stale entry directly (as if an earlier probe resolved to b).
    const seeder = new KvCache(kv as never);
    await seeder.putJson('davRoute', ['owner', 'movedvol'], { backendId: '2', slug: 'b', baseUrl: 'https://b.example.com' });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/movedvol',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'movedvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(res.status).toBe(207);
    expect(calls.at(-1)?.url).toBe('https://a.example.com/owner/movedvol');  });

  it('volume-root DELETE evicts; inner-file PUT does not', async () => {
    const calls = stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 207 }, 204);
    const kv = makeFakeKv();
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const rootHandler = routes.get('ON /:owner/:volume')!;
    const subHandler = routes.get('ON /:owner/:volume/*')!;
    const rootCtx = (method: string) =>
      fakeContext({
        method,
        url: 'https://router.example.com/owner/mutvol',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'mutvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never;
    // Seed via PROPFIND (forward 204 here is fine; status only matters later).
    await rootHandler(rootCtx('PROPFIND'));
    expect(probeCount(calls)).toBe(2);
    // Inner PUT (forward 204): ownership unchanged → still cached.
    const putRes = await subHandler(
      fakeContext({
        method: 'PUT',
        url: 'https://router.example.com/owner/mutvol/file.txt',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'mutvol' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    expect(putRes.status).toBe(204);
    await rootHandler(rootCtx('PROPFIND'));
    expect(probeCount(calls)).toBe(2);
    // Volume-root DELETE: evicted → next request re-probes.
    const delRes = await rootHandler(rootCtx('DELETE'));
    expect(delRes.status).toBe(204);
    await rootHandler(rootCtx('PROPFIND'));
    expect(probeCount(calls)).toBe(4);
  });

  it('answers a non-DAV method with 405 and Allow, not 404', async () => {
    // The DAV handlers are registered per-method, so `POST /owner/vol` used to
    // match no route at all and fell through to Hono's default 404. Clients
    // use the 404-vs-405 distinction to tell "wrong verb" from "no such
    // bucket".
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    for (const key of ['ALL /:owner/:volume', 'ALL /:owner/:volume/*']) {
      const handler = routes.get(key);
      expect(handler, `expected ${key} to be registered`).toBeTruthy();
      const res = await handler!(
        fakeContext({
          method: 'POST',
          url: 'https://router.example.com/owner/somevol',
          env: { DB: db },
          params: { owner: 'owner', volume: 'somevol' },
          body: 'x',
        }) as never,
      );
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toContain('PROPFIND');
    }
  });

  it('never forwards the caller credentials to a probe target', async () => {
    // The candidate set is not scoped by requester: `backend_username` is
    // cached from whatever a backend's /user/me reports, so any account can
    // register a backend claiming a victim handle and land in the victim's
    // candidate set. Sending the victim's bucket password to every candidate
    // would disclose it to those third-party origins.
    const calls = stubFetchWithProbes({ 'https://a.example.com': 207, 'https://b.example.com': 404 }, 207);
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/creds',
        env: { DB: db },
        params: { owner: 'owner', volume: 'creds' },
        headers: { Authorization: 'Basic dmljdGltOnNlY3cmV0', Cookie: 'session=abc', 'Cf-Access-Jwt-Assertion': 'jwt.token.here' },
      }) as never,
    );
    // `stubFetchWithProbes` also treats the real forward as a probe when it
    // carries Depth: 0, so identify probes by their synthetic credential —
    // which is precisely the property under test.
    const probes = calls.filter((c) => new Headers(c.init.headers).get('Authorization') === PROBE_AUTHORIZATION);
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      const headers = new Headers(probe.init.headers);
      // The probe must not be usable as a credential by any backend.
      expect(Buffer.from(PROBE_AUTHORIZATION.replace('Basic ', ''), 'base64').toString('utf8')).toBe('router-probe:');
      expect(headers.get('Cookie')).toBeNull();
      expect(headers.get('Cf-Access-Jwt-Assertion')).toBeNull();
      expect(headers.get('Authorization')).not.toBe('Basic dmljdGltOnNlY3cmV0');
    }
    // The real forward still carries the caller's credentials verbatim.
    const forward = calls.find((c) => new Headers(c.init.headers).get('Authorization') === 'Basic dmljdGltOnNlY3cmV0');
    expect(forward, 'the chosen backend must receive the caller credentials').toBeTruthy();
  });

  it('refuses to fan out probes past the candidate cap', async () => {
    // Each candidate is an outbound subrequest triggered by one unauthenticated
    // request, so an unbounded fan-out is a free amplification vector.
    const many = Array.from({ length: MAX_PROBE_CANDIDATES + 5 }, (_, i) => ({
      id: String(i),
      owner_email: `o${i}@example.com`,
      slug: `s${i}`,
      base_url: `https://b${i}.example.com`,
      backend_username: 'collider',
    }));
    const calls = stubFetchWithProbes({}, 207);
    const db = fakeDb({ backends: many });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/floodvol',
        env: { DB: db },
        params: { owner: 'collider', volume: 'floodvol' },
      }) as never,
    );
    expect(res.status).toBe(409);
    expect(probeCount(calls)).toBe(0);
  });

  it('drops 502/504 from the staleness set so a backend blip is not mistaken for a moved volume', async () => {
    const calls: CapturedFetch[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
        calls.push({ url, init: init ?? {} });
        const headers = new Headers((init?.headers ?? {}) as HeadersInit);
        if ((init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0') {
          return new Response('<ok/>', { status: 207 });
        }
        // A valid backend that is briefly overloaded.
        return new Response('upstream error', { status: 502 });
      },
    );
    const kv = makeFakeKv();
    const seeder = new KvCache(kv as never);
    await seeder.putJson('davRoute', ['owner', 'blipvol'], { backendId: '1', slug: 'a', baseUrl: 'https://a.example.com' });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        url: 'https://router.example.com/owner/blipvol',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'blipvol' },
      }) as never,
    );
    // Served as-is, with no re-probe: the route was never stale.
    expect(res.status).toBe(502);
    expect(probeCount(calls)).toBe(0);
  });

  it('does not replay a mutating request against a second backend on a stale route', async () => {
    // Self-healing by re-forwarding re-sent a body that had already been
    // consumed, so a PUT could silently write a truncated (or empty) file, and
    // a mutation that succeeded before its response was lost would be applied
    // twice — once to each of two backends.
    const forwards: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
        const headers = new Headers((init?.headers ?? {}) as HeadersInit);
        if ((init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0') {
          return new Response(url.startsWith('https://a.example.com') ? '<ok/>' : 'probe', {
            status: url.startsWith('https://a.example.com') ? 207 : 404,
          });
        }
        forwards.push(`${init?.method} ${url}`);
        return new Response('gone', { status: 404 });
      },
    );
    const kv = makeFakeKv();
    const seeder = new KvCache(kv as never);
    await seeder.putJson('davRoute', ['owner', 'mvvol'], { backendId: '2', slug: 'b', baseUrl: 'https://b.example.com' });
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume')!(
      fakeContext({
        method: 'PUT',
        url: 'https://router.example.com/owner/mvvol',
        env: { DB: db, CACHE: kv },
        params: { owner: 'owner', volume: 'mvvol' },
        body: 'payload',
      }) as never,
    );
    expect(res.status).toBe(404);
    // Exactly one forward, to the cached origin — never a second backend.
    expect(forwards).toEqual(['PUT https://b.example.com/owner/mvvol']);
  });
});
