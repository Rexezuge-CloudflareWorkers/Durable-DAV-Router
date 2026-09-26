import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRouterDavProxyRoutes } from '../apps/api/src/workers/routes/RouterDavProxyRoutes';

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

function fakeDb(opts: {
  backends: Array<{ id: string; owner_email: string; slug: string; base_url: string; backend_username?: string | null }>;
}) {
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
          if (state.sql.includes('FROM router_backends')) {
            const email = String(state.values[0]).toLowerCase();
            const results = opts.backends
              .filter((b) => b.owner_email.toLowerCase() === email)
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

describe('RouterDavProxyRoutes owner routing', () => {
  let captured: CapturedFetch | null = null;

  beforeEach(() => {
    captured = null;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
        captured = { url, init: init ?? {} };
        return new Response('<ok/>', {
          status: 207,
          headers: { 'Content-Type': 'application/xml', DAV: '1, 2', 'MS-Author-Via': 'DAV' },
        });
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 404 (not 401) for unknown owners without Access identity', async () => {
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
  });

  it('proxies single-backend owner requests without Access identity', async () => {
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
    expect(captured?.url).toBe('https://backend.example.com/Starfish/test123');
    const headers = captured?.init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Basic eA==');
    expect(headers.get('Cookie')).toBe('CF_Authorization=abc');
    expect(headers.get('Depth')).toBe('1');
    expect(captured?.init.redirect).toBe('manual');
    // Backend DAV + Windows compat headers survive the allowlist.
    expect(res.headers.get('DAV')).toBe('1, 2');
    expect(res.headers.get('MS-Author-Via')).toBe('DAV');
  });

  it('strips ?backend= and preserves trailing slash on collections', async () => {
    const db = fakeDb({
      backends: [{ id: '1', owner_email: 'starfish@example.com', slug: 'solo', base_url: 'https://backend.example.com', backend_username: 'starfish' }],
    });
    const { app, routes } = stubApp();
    registerRouterDavProxyRoutes(app as never);
    const handler = routes.get('ON /:owner/:volume/*');
    // Simulate Hono `/:owner/:volume/*` with encoded inner path.
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
          raw: new Request(fullUrl, {
            method: 'PROPFIND',
            headers: { Authorization: 'Basic eA==' },
          }),
          url: fullUrl,
          param: (n: string) => ({ owner: 'starfish', volume: 'vol' })[n],
          query: (k: string) => new URL(fullUrl).searchParams.get(k) ?? undefined,
          header: (k: string) =>
            new Request(fullUrl, {
              method: 'PROPFIND',
              headers: { Authorization: 'Basic eA==' },
            }).headers.get(k) ?? undefined,
        },
      } as never,
    );
    expect(res.status).toBe(207);
    expect(captured?.url).toBe('https://backend.example.com/starfish/vol/folder%20a/?foo=1');
  });

  it('returns 409 without slug enumeration when multiples match', async () => {
    const db = fakeDb({
      backends: [
        { id: '1', owner_email: 'o@example.com', slug: 'a', base_url: 'https://a.example.com', backend_username: 'owner' },
        { id: '2', owner_email: 'other@example.com', slug: 'b', base_url: 'https://b.example.com', backend_username: 'owner' },
      ],
    });
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
    expect(captured).toBeNull();
  });
});
