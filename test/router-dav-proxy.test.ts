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
            return hit ? (toRow(hit) as T) : null;
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

/**
Fetch stub where volume-root `PROPFIND Depth: 0` probes get per-origin statuses.
*/
function stubFetchWithProbes(probeStatusByOrigin: Record<string, number>, forwardStatus = 207) {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, init: init ?? {} });
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    const isProbe = (init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0' && !url.includes('/folder');
    if (isProbe) {
      const origin = new URL(url).origin;
      const status = probeStatusByOrigin[origin] ?? 404;
      return new Response(status === 207 ? '<ok/>' : 'probe', { status });
    }
    const status = forwardStatus;
    const noBody = [204, 205, 304].includes(status);
    return new Response(noBody ? null : status === 401 ? 'unauthorized' : '<ok/>', {
      status,
      headers:
        status === 207
          ? { 'Content-Type': 'application/xml', DAV: '1, 2', 'MS-Author-Via': 'DAV' }
          : { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="backend"' },
    });
  });
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
      backends: [
        {
          id: '1',
          owner_email: 'starfish@example.com',
          slug: 'solo',
          base_url: 'https://backend.example.com',
          backend_username: 'Starfish',
        },
      ],
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

  it('forwards a DAV OPTIONS capability probe and returns the backend DAV: header', async () => {
    // The regression this pins: a terminal `app.options('*')` preflight handler
    // in the worker answered every OPTIONS with a bare 204, so this proxy never
    // ran and no client ever saw a `DAV:` header. RFC 4918 §9.1 requires it, and
    // clients that probe on connect aborted with "No Content". The stub mirrors
    // the real backend (`DavRoutes.handleDav`): 200 + Allow + DAV + MS-Author-Via.
    const calls: CapturedFetch[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input instanceof Request ? input.url : input), init: init ?? {} });
      return new Response(null, {
        status: 200,
        headers: {
          Allow: 'OPTIONS, PROPFIND, GET, PUT, DELETE',
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
        },
      });
    });
    const db = fakeDb({
      backends: [
        {
          id: '1',
          owner_email: 'starfish@example.com',
          slug: 'solo',
          base_url: 'https://backend.example.com',
          backend_username: 'Starfish',
        },
      ],
    });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume');
    const res = await handler!(
      fakeContext({
        method: 'OPTIONS',
        url: 'https://router.example.com/Starfish/test123',
        env: { DB: db },
        params: { owner: 'Starfish', volume: 'test123' },
        headers: { Authorization: 'Basic eA==' },
      }) as never,
    );
    // The probe actually reached the origin, not a router shortcut.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://backend.example.com/Starfish/test123');
    expect(calls[0].init.method).toBe('OPTIONS');
    // The advertisement rides back to the client untouched.
    expect(res.status).toBe(200);
    expect(res.headers.get('DAV')).toBe('1, 2');
    expect(res.headers.get('Allow')).toContain('PROPFIND');
    expect(res.headers.get('MS-Author-Via')).toBe('DAV');
  });

  it('strips ?backend= and preserves trailing slash on collections', async () => {
    stubFetchWithProbes({});
    const db = fakeDb({
      backends: [
        {
          id: '1',
          owner_email: 'starfish@example.com',
          slug: 'solo',
          base_url: 'https://backend.example.com',
          backend_username: 'starfish',
        },
      ],
    });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume/*');
    const rawPath = '/starfish/vol/folder%20a/';
    const fullUrl = `https://router.example.com${rawPath}?backend=solo&foo=1`;
    const res = await handler!({
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
        header: (k: string) =>
          new Request(fullUrl, { method: 'PROPFIND', headers: { Authorization: 'Basic eA==' } }).headers.get(k) ?? undefined,
      },
    } as never);
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

/**
 * `fetch` accepts a string, a `URL`, or a `Request`; every stub here wants the URL.
 */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function probeCount(calls: CapturedFetch[]): number {
  return calls.filter((c) => new Headers(c.init.headers as HeadersInit).get('Depth') === '0').length;
}

/**
 * KV double that counts operations.
 *
 * The failure these tests exist for was a daily write/delete quota exhausted in
 * 40 minutes, and no status-code assertion can see it: every request in the
 * loop answered correctly. Asserting the *cost* of a request is the only way to
 * pin it.
 */
function countingKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const ops = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    store,
    ops,
    get(key: string): Promise<string | null> {
      ops.get += 1;
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key: string, value: string): Promise<void> {
      ops.put += 1;
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      ops.delete += 1;
      store.delete(key);
      return Promise.resolve(true);
    },
    list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      ops.list += 1;
      return Promise.resolve({
        keys: [...store.keys()].filter((name) => name.startsWith(options.prefix)).map((name) => ({ name })),
        list_complete: true,
      });
    },
  };
}

/**
 * Fetch stub for write-budget tests: volume-root `Depth: 0` probes answer per
 * origin, and every forward 404s — the state a client in a resync loop, or one
 * walking a tree of already-deleted files, keeps the router in.
 */
function stubProbesAndFailingForwards(probeStatusByOrigin: Record<string, number>) {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, init: init ?? {} });
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    if ((init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0') {
      const status = probeStatusByOrigin[new URL(url).origin] ?? 404;
      return new Response(status === 207 ? '<ok/>' : 'probe', { status });
    }
    return new Response('gone', { status: 404 });
  });
  return calls;
}

// Every request answers `207 Multi-Status`, so only the route cache varies.
function stubEverythingAnswers207(): void {
  vi.stubGlobal('fetch', async () => new Response('<ok/>', { status: 207, headers: { 'Content-Type': 'application/xml' } }));
}

/**
 * Probes succeed, plain forwards answer a backend authorization refusal.
 *
 * The body is a real `DAV:error` document with the `Content-Type` the backend
 * sets, and no `WWW-Authenticate` — the exact shape a read-only credential's
 * refusal has upstream, so a test can assert the router relays it rather than
 * re-authoring or embellishing it.
 */
function stubForwardStatus(status: number): CapturedFetch[] {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, init: init ?? {} });
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    if ((init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0') {
      return new Response('<ok/>', { status: 207, headers: { 'Content-Type': 'application/xml' } });
    }
    return new Response('<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:cannot-modify-protected-property/></D:error>', {
      status,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  });
  return calls;
}

// Probes are indeterminate (`502`) while plain forwards answer `404`.
function stubProbesUnavailableForwards404(): void {
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    const isProbe = (init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0';
    return isProbe ? new Response('down', { status: 502 }) : new Response('gone', { status: 404 });
  });
}

/**
 * Repeat a request as a *different isolate* would see it.
 *
 * The per-isolate L1 legitimately absorbs a warm route, so without dropping it
 * a repeated request never reaches KV and the budget it spends is invisible.
 * `clearRouteCacheL1` between iterations forces the KV read a fresh isolate pays,
 * which is the state a real sync spreads itself across.
 */
async function repeatAcrossIsolates(count: number, run: () => Promise<Response>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    clearRouteCacheL1();
    const res = await run();
    statuses.push(res.status);
  }
  return statuses;
}

describe('RouterDavProxyRoutes KV write budget', () => {
  beforeEach(() => {
    clearRouteCacheL1();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearRouteCacheL1();
  });

  const SOLO: BackendSeed[] = [
    { id: '1', owner_email: 'o@example.com', slug: 'solo', base_url: 'https://backend.example.com', backend_username: 'owner' },
  ];

  function proxyFor(kv: unknown, db: unknown, url: string, method = 'GET') {
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume/*')!;
    const { pathname } = new URL(url);
    const [, owner, volume] = pathname.split('/', 3);
    return () =>
      handler(
        fakeContext({
          method,
          url,
          env: { DB: db, CACHE: kv },
          params: { owner, volume },
          headers: { Authorization: 'Basic eA==' },
        }) as never,
      );
  }

  it('spends one write total on a client that 404s on every inner path', async () => {
    // The reported failure. A bare client asking for files that are not there
    // used to spend a delete plus a put of the identical value on *every*
    // request, because a 404 evicted the route and the re-resolution
    // immediately re-stored it. The response was correct throughout; only the
    // quota moved, 1,000 writes and 1,000 deletes gone in well under an hour.
    stubProbesAndFailingForwards({ 'https://a.example.com': 404, 'https://b.example.com': 207 });
    const kv = countingKv();
    const request = proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/gonevol/missing.txt');
    const statuses = await repeatAcrossIsolates(6, request);
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
    // The first request resolves and caches; the five 404s after it cost nothing.
    expect(kv.ops.put).toBe(1);
    expect(kv.ops.delete).toBe(0);
  });

  it('spends nothing when a root 404 re-resolves to the backend already cached', async () => {
    // The volume is simply gone from that origin. The entry already names the
    // right backend, so there is no value to write — a delete here buys a
    // re-probe on the next request and nothing else.
    stubProbesAndFailingForwards({ 'https://a.example.com': 404, 'https://b.example.com': 207 });
    const kv = countingKv({ 'davRoute:v1:owner:root404': JSON.stringify({ backendId: '2', slug: 'b', baseUrl: 'https://b.example.com' }) });
    const request = proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/root404', 'PROPFIND');
    const statuses = await repeatAcrossIsolates(4, request);
    expect(statuses).toEqual([404, 404, 404, 404]);
    expect(kv.ops.put).toBe(0);
    expect(kv.ops.delete).toBe(0);
  });

  it('replaces a stale entry with one put and no delete when the volume moved', async () => {
    // `put` is an upsert, so the stale value never needed deleting first. The
    // pair of operations is the whole point: one write, and it is a real change.
    stubProbesAndFailingForwards({ 'https://a.example.com': 207, 'https://b.example.com': 404 });
    const kv = countingKv({ 'davRoute:v1:owner:moved': JSON.stringify({ backendId: '2', slug: 'b', baseUrl: 'https://b.example.com' }) });
    const request = proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/moved', 'PROPFIND');
    await repeatAcrossIsolates(2, request);
    expect(kv.ops.put).toBe(1);
    expect(kv.ops.delete).toBe(0);
    expect(JSON.parse(kv.store.get('davRoute:v1:owner:moved') ?? '{}')).toMatchObject({
      backendId: '1',
      baseUrl: 'https://a.example.com',
    });
  });

  it('evicts a stale entry exactly once when no backend claims the volume', async () => {
    // Afterwards there is no entry left to evict, so a client that keeps asking
    // for a deleted bucket costs a single delete rather than one per request.
    stubProbesAndFailingForwards({});
    const kv = countingKv({ 'davRoute:v1:owner:nobody': JSON.stringify({ backendId: '2', slug: 'b', baseUrl: 'https://b.example.com' }) });
    const request = proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/nobody', 'PROPFIND');
    const statuses = await repeatAcrossIsolates(3, request);
    expect(statuses).toEqual([404, 404, 404]);
    expect(kv.ops.put).toBe(0);
    expect(kv.ops.delete).toBe(1);
  });

  it('never writes a route for a lone-backend owner', async () => {
    // `resolveBackend` short-circuits a one-candidate set without probing, so an
    // entry here would cache a value the same request's D1 read already
    // produced — a scarce KV write spent to save a cheap D1 read.
    stubProbesAndFailingForwards({ 'https://backend.example.com': 207 });
    const kv = countingKv();
    const request = proxyFor(kv, fakeDb({ backends: SOLO }), 'https://router.example.com/owner/solovol/file.txt');
    await repeatAcrossIsolates(3, request);
    expect(kv.ops.put).toBe(0);
    expect(kv.store.size).toBe(0);
  });

  it('drops an entry whose base_url was edited, without any purge to do it', async () => {
    // The safety net is the per-request D1 revalidation, not a namespace sweep
    // on the settings page. A purged namespace cost one delete per cached route
    // in the *account* for a single user's save.
    stubEverythingAnswers207();
    const kv = countingKv({
      'davRoute:v1:owner:edited': JSON.stringify({ backendId: '1', slug: 'solo', baseUrl: 'https://old.example.com' }),
    });
    const request = proxyFor(kv, fakeDb({ backends: SOLO }), 'https://router.example.com/owner/edited');
    const statuses = await repeatAcrossIsolates(1, request);
    expect(statuses).toEqual([207]);
    expect(kv.ops.put).toBe(0);
    expect(kv.ops.delete).toBe(1);
    expect(kv.store.size).toBe(0);
  });

  it('drops an entry naming a deleted backend, and forwards to the survivor', async () => {
    stubEverythingAnswers207();
    const kv = countingKv({
      'davRoute:v1:owner:orphaned': JSON.stringify({ backendId: '99', slug: 'gone', baseUrl: 'https://gone.example.com' }),
    });
    const request = proxyFor(kv, fakeDb({ backends: SOLO }), 'https://router.example.com/owner/orphaned');
    const res = await request();
    expect(res.status).toBe(207);
    expect(kv.ops.delete).toBe(1);
    expect(kv.store.size).toBe(0);
  });

  it('keeps a merely-suspect entry when the origins turn out to be unreachable', async () => {
    // The cached origin 404s the volume root, then every candidate is down. A
    // 502 says the backends are unreachable, not that the route is wrong, so
    // there is no evidence to act on and nothing is written — `502` is
    // deliberately excluded from the staleness set for the same reason.
    stubProbesUnavailableForwards404();
    const kv = countingKv({
      'davRoute:v1:owner:blip': JSON.stringify({ backendId: '1', slug: 'a', baseUrl: 'https://a.example.com' }),
    });
    const request = proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/blip', 'PROPFIND');
    const statuses = await repeatAcrossIsolates(1, request);
    expect(statuses).toEqual([502]);
    expect(kv.ops.put).toBe(0);
    expect(kv.ops.delete).toBe(0);
    expect(kv.store.size).toBe(1);
  });

  it('still evicts a D1-proven entry when the origins turn out to be unreachable', async () => {
    // The mirror image, and why the eviction is conditional on *why* the entry
    // was distrusted: D1 already established this entry names a `base_url` that
    // no longer exists, so an unreachable candidate set adds nothing — the entry
    // is wrong regardless and has to go.
    stubProbesUnavailableForwards404();
    const kv = countingKv({
      'davRoute:v1:owner:blip': JSON.stringify({ backendId: '1', slug: 'a', baseUrl: 'https://edited.example.com' }),
    });
    const request = proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/blip', 'PROPFIND');
    const statuses = await repeatAcrossIsolates(1, request);
    expect(statuses).toEqual([502]);
    expect(kv.ops.delete).toBe(1);
    expect(kv.store.size).toBe(0);
  });

  it('spends nothing when a read-only credential retries a refused write', async () => {
    // A backend 403 is an authorization answer about one credential, not
    // evidence that the route is wrong — so it must not enter the staleness
    // set, and `trackVolumeMutation` must skip it as it skips every non-2xx.
    // A client looping on a refused PUT is the exact shape that once spent the
    // daily write budget in ~40 minutes while answering every request correctly.
    stubForwardStatus(403);
    const kv = countingKv({
      'davRoute:v1:owner:photos': JSON.stringify({ backendId: '1', slug: 'a', baseUrl: 'https://a.example.com' }),
    });
    const request = proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/photos/notes.txt', 'PUT');
    const statuses = await repeatAcrossIsolates(6, request);
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
    expect(kv.ops.put).toBe(0);
    expect(kv.ops.delete).toBe(0);
    // The entry survives: the route is still correct, it was the credential
    // that was refused.
    expect(kv.store.size).toBe(1);
  });

  it('forwards a backend 403 with its DAV:error body and no Basic challenge', async () => {
    // The backend owns this refusal. The router must not translate it, and must
    // not add `WWW-Authenticate` — that header on a 403 sends a native client
    // into a re-prompt loop it can never satisfy. Both are asserted because
    // either one would be invisible to a status-only test.
    const calls = stubForwardStatus(403);
    const kv = countingKv({
      'davRoute:v1:owner:photos': JSON.stringify({ backendId: '1', slug: 'a', baseUrl: 'https://a.example.com' }),
    });
    const res = await proxyFor(kv, fakeDb({ backends: BACKENDS_TWO }), 'https://router.example.com/owner/photos/notes.txt', 'PUT')();

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('cannot-modify-protected-property');
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    // The write reached exactly one backend — the cached one.
    const forwards = calls.filter((c) => (c.init.method ?? 'GET') === 'PUT');
    expect(forwards).toHaveLength(1);
    expect(forwards[0]?.url).toBe('https://a.example.com/owner/photos/notes.txt');
  });
});

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
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const origin = new URL(url).origin;
      calls.push({ url, init: init ?? {} });
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      const isProbe = (init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0';
      if (isProbe) {
        // Volume moved from b to a between requests.
        return new Response('probe', { status: origin === 'https://a.example.com' ? 207 : 404 });
      }
      // Forward to the stale backend 404s; the new owner serves.
      const stale = origin === 'https://b.example.com';
      return new Response(stale ? 'gone' : '<ok/>', {
        status: stale ? 404 : 207,
      });
    });
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
    expect(calls.at(-1)?.url).toBe('https://a.example.com/owner/movedvol');
  });

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
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      calls.push({ url, init: init ?? {} });
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      if ((init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0') {
        return new Response('<ok/>', { status: 207 });
      }
      // A valid backend that is briefly overloaded.
      return new Response('upstream error', { status: 502 });
    });
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
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const origin = new URL(url).origin;
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      if ((init?.method ?? 'GET') === 'PROPFIND' && headers.get('Depth') === '0') {
        const moved = origin === 'https://a.example.com';
        return new Response(moved ? '<ok/>' : 'probe', {
          status: moved ? 207 : 404,
        });
      }
      forwards.push(`${init?.method} ${url}`);
      return new Response('gone', { status: 404 });
    });
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

/**
 * Backend `href_prefix_mode` = `root` passthrough.
 *
 * A backend may anchor its `DAV:href` values at the server root rather than
 * carrying `/owner/volume` — its per-bucket setting, for clients that 404 on
 * the RFC-conforming shape. The router's job here is to add *nothing*: forward
 * the body, and swap only the origin on a `Destination`.
 *
 * These cases exist because the two halves are separately plausible and jointly
 * load-bearing. Forwarding the body unparsed is what makes a root-anchored href
 * reach the client intact, and swapping only the origin is what lets the client
 * send that href back and have the backend resolve it. A change to either would
 * leave a client that lists a directory and then cannot move or copy in it.
 */
describe('RouterDavProxyRoutes root-anchored href passthrough', () => {
  beforeEach(() => {
    clearRouteCacheL1();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearRouteCacheL1();
  });

  const SOLO: BackendSeed[] = [
    { id: '1', owner_email: 'o@example.com', slug: 'solo', base_url: 'https://backend.example.com', backend_username: 'owner' },
  ];

  it('forwards a root-anchored 207 body unparsed', async () => {
    // The response body must arrive byte-identical: the router has no href
    // builder, so any rewriting here would have to be a string transform over
    // XML it deliberately does not parse.
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n<response>\n<href>/</href>\n</response>\n<response>\n<href>/docs/</href>\n</response>\n<response>\n<href>/docs/a.txt</href>\n</response>\n</multistatus>\n`;
    vi.stubGlobal('fetch', async () => new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } }));
    const db = fakeDb({ backends: SOLO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume/*')!(
      fakeContext({
        url: 'https://router.example.com/owner/vol/docs',
        env: { DB: db },
        params: { owner: 'owner', volume: 'vol' },
        headers: { Authorization: 'Basic eA==', Depth: '1' },
      }) as never,
    );
    expect(res.status).toBe(207);
    expect(await res.text()).toBe(body);
  });

  it('origin-swaps a root-anchored Destination and preserves its path verbatim', async () => {
    // The client echoes back an href it was given. Because the rewrite swaps
    // only the origin and keeps `pathname`, `/docs/a.txt` reaches the backend as
    // `https://backend.example.com/docs/a.txt` — which is what lets the backend
    // resolve it in root mode. A rewrite that re-attached the volume base here
    // would double it.
    const calls = stubFetchWithProbes({}, 201);
    const db = fakeDb({ backends: SOLO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const res = await routes.get('ON /:owner/:volume/*')!(
      fakeContext({
        method: 'MOVE',
        url: 'https://router.example.com/owner/vol/docs/a.txt',
        env: { DB: db },
        params: { owner: 'owner', volume: 'vol' },
        headers: { Authorization: 'Basic eA==', Destination: 'https://router.example.com/docs/b.txt', Overwrite: 'F' },
      }) as never,
    );
    expect(res.status).toBe(201);
    const forward = calls.at(-1)!;
    expect(forward.url).toBe('https://backend.example.com/owner/vol/docs/a.txt');
    expect((forward.init.headers as Headers).get('Destination')).toBe('https://backend.example.com/docs/b.txt');
  });

  it('keeps the router selector out of a rewritten Destination', async () => {
    // The backend has no `?backend=` concept, and the selector is stripped
    // surgically rather than via a URLSearchParams round trip so signature-bearing
    // queries survive — a root-anchored destination must not reintroduce one.
    const calls = stubFetchWithProbes({}, 201);
    const db = fakeDb({ backends: SOLO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    await routes.get('ON /:owner/:volume/*')!(
      fakeContext({
        method: 'COPY',
        url: 'https://router.example.com/owner/vol/a.txt',
        env: { DB: db },
        params: { owner: 'owner', volume: 'vol' },
        headers: { Authorization: 'Basic eA==', Destination: 'https://router.example.com/b.txt?backend=solo&sig=abc%20d' },
      }) as never,
    );
    const destination = (calls.at(-1)!.init.headers as Headers).get('Destination');
    expect(destination).toBe('https://backend.example.com/b.txt?sig=abc%20d');
  });

  it('leaves a cross-origin Destination for the backend to refuse', async () => {
    // The router is not the authority on WebDAV destination validity; rewriting
    // only same-router origins keeps that decision where the bucket's own rules
    // live.
    const calls = stubFetchWithProbes({}, 502);
    const db = fakeDb({ backends: SOLO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    await routes.get('ON /:owner/:volume/*')!(
      fakeContext({
        method: 'MOVE',
        url: 'https://router.example.com/owner/vol/a.txt',
        env: { DB: db },
        params: { owner: 'owner', volume: 'vol' },
        headers: { Authorization: 'Basic eA==', Destination: 'https://evil.example.net/steal' },
      }) as never,
    );
    expect((calls.at(-1)!.init.headers as Headers).get('Destination')).toBe('https://evil.example.net/steal');
  });

  it('leaves the routed volume cached after a root-anchored same-volume move', async () => {
    // Documented, deliberate behaviour rather than a bug: a root-anchored
    // `Destination` carries no owner/volume, so `parseDestinationVolume` invents
    // one from the first two segments (`docs`/`b.txt`) and `trackVolumeMutation`
    // purges *that* fabricated key. The request's own route entry must survive,
    // or every root-mode MOVE would cost a re-probe of the whole candidate set.
    //
    // Two backends sharing the owner, so routing is genuinely ambiguous and the
    // cache is genuinely consulted — with one backend there is no probe and the
    // assertion below would hold vacuously.
    const calls = stubFetchWithProbes({ 'https://a.example.com': 404, 'https://b.example.com': 207 }, 201);
    const kv = makeFakeKv();
    const db = fakeDb({ backends: BACKENDS_TWO });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume/*')!;
    const move = () =>
      handler(
        fakeContext({
          method: 'MOVE',
          url: 'https://router.example.com/owner/destvol/a.txt',
          env: { DB: db, CACHE: kv },
          params: { owner: 'owner', volume: 'destvol' },
          headers: { Authorization: 'Basic eA==', Destination: 'https://router.example.com/docs/b.txt' },
        }) as never,
      );
    // First move: ambiguous owner, so both backends are probed and the route is
    // cached against `owner`/`destvol`.
    const first = await move();
    expect(first.status).toBe(201);
    const afterFirst = probeCount(calls);
    expect(afterFirst).toBe(2);
    expect([...kv.store.keys()].some((k) => k.includes('destvol'))).toBe(true);

    // Second identical move: a cache hit, so the fabricated `docs`/`b.txt` purge
    // demonstrably did not evict the real entry.
    const second = await move();
    expect(second.status).toBe(201);
    expect(probeCount(calls)).toBe(afterFirst);
  });
});
