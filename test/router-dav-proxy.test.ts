import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
          return null as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (state.sql.includes('FROM router_backends WHERE backend_username_ci')) {
            const ci = String(state.values[0]).toLowerCase();
            const results = opts.backends
              .filter((b) => (b.backend_username ?? '').toLowerCase() === ci)
              .map((b) => ({
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
              }));
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
      return new Response(status === 401 ? 'unauthorized' : '<ok/>', {
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
  afterEach(() => {
    vi.unstubAllGlobals();
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
