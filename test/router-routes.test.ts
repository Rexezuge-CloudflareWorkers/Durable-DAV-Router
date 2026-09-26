import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';
import { registerAggregatedVolumeRoutes } from '../apps/api/src/workers/routes/AggregatedVolumeRoutes';
import { registerBackendRoutes } from '../apps/api/src/workers/routes/BackendRoutes';

type Row = RouterBackendRow;
type Handler = (c: FakeContext) => Promise<Response>;

interface FakeContext {
  req: {
    raw: Request;
    param: (n: string) => string | undefined;
    query: (k: string) => string | undefined;
    header: (k: string) => string | undefined;
    json: () => Promise<unknown>;
  };
  env: Record<string, unknown>;
  get: (k: string) => string;
  json: (data: unknown, status?: number) => Response;
}

function fakeDb(): { db: { prepare: (sql: string) => unknown }; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const db = {
    prepare(query: string) {
      const state: { sql: string; values: unknown[] } = { sql: query, values: [] };
      const stmt = {
        bind(...values: unknown[]) {
          state.values = values;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          const [v0, v1] = state.values as string[];
          if (state.sql.includes('slug_ci = ?')) {
            const found = [...rows.values()].find((r) => r.owner_email.toLowerCase() === v0.toLowerCase() && r.slug_ci === v1);
            return (found ?? null) as T | null;
          }
          if (state.sql.includes('WHERE id = ?')) {
            return (rows.get(v0) ?? null) as T | null;
          }
          return state.sql.includes('COUNT(*)')
            ? ({ cnt: [...rows.values()].filter((r) => r.owner_email.toLowerCase() === v0.toLowerCase()).length } as T)
            : null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const [v0] = state.values as [string];
          if (state.sql.includes('backend_username_ci = ?')) {
            return {
              results: [...rows.values()].filter((r) => (r.backend_username_ci ?? '').toLowerCase() === v0.toLowerCase()) as T[],
            };
          }
          return { results: [...rows.values()].filter((r) => r.owner_email.toLowerCase() === v0.toLowerCase()) as T[] };
        },
        async run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
          if (state.sql.startsWith('INSERT INTO router_backends')) {
            const [id, ownerEmail, slug, slugCi, baseUrl, displayName, createdAt, updatedAt] = state.values as [
              string,
              string,
              string,
              string,
              string,
              string | null,
              number,
              number,
            ];
            rows.set(id, {
              id,
              owner_email: ownerEmail,
              slug,
              slug_ci: slugCi,
              base_url: baseUrl,
              display_name: displayName,
              created_at: createdAt,
              updated_at: updatedAt,
              last_seen_at: null,
              last_status: null,
              backend_username: null,
              backend_username_ci: null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (state.sql.startsWith('UPDATE router_backends')) {
            const id = String(state.values.at(-1));
            const cur = rows.get(id);
            if (cur) rows.set(id, { ...cur, updated_at: Date.now() });
            return { success: true, meta: { changes: 1 } };
          }
          if (state.sql.startsWith('DELETE FROM router_backends')) {
            rows.delete(String(state.values[0]));
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: state.sql.startsWith('INSERT INTO users') ? 1 : 0 } };
        },
      };
      return stmt;
    },
  };
  return { db, rows };
}

function stubApp() {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => {
      routes.set(`GET ${path}`, handler);
    },
    post: (path: string, handler: Handler) => {
      routes.set(`POST ${path}`, handler);
    },
    patch: (path: string, handler: Handler) => {
      routes.set(`PATCH ${path}`, handler);
    },
    delete: (path: string, handler: Handler) => {
      routes.set(`DELETE ${path}`, handler);
    },
    on: (_methods: unknown, path: string, handler: Handler) => {
      routes.set(`ON ${path}`, handler);
    },
  };
  return { app, routes };
}

function fakeContext(opts: {
  method?: string;
  url?: string;
  env: Record<string, unknown>;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}): FakeContext {
  const url = opts.url ?? 'https://router.example.com/';
  const headers = new Headers({ 'Content-Type': 'application/json', ...opts.headers });
  const raw = new Request(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const parsed = new URL(url);
  return {
    req: {
      raw,
      param: (n: string) => opts.params?.[n],
      query: (k: string) => parsed.searchParams.get(k) ?? undefined,
      header: (k: string) => raw.headers.get(k) ?? undefined,
      json: async () => opts.body ?? {},
    },
    env: opts.env,
    get: (k: string) => (k === 'AuthenticatedUserEmailAddress' ? 'test@example.com' : ''),
    json: (data: unknown, status = 200) => Response.json(data, { status }),
  };
}

const ENV_BASE = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'test@example.com' };

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.endsWith('/health')) return Response.json({ ok: true }, { status: 200 });
    return url.endsWith('/user/volumes')
      ? Response.json({ volumes: [{ owner: 'test', name: 'photos', isPrivate: true }] })
      : new Response('not found', { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backend + aggregated volume routes', () => {
  it('rejects backend creation without slug/baseUrl', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    const handler = routes.get('POST /user/backends');
    expect(handler).toBeDefined();
    const res = await handler!(
      fakeContext({ method: 'POST', url: 'https://router.example.com/user/backends', env: { ...ENV_BASE, DB: db }, body: {} }),
    );
    expect(res.status).toBe(400);
  });

  it('creates, reads, patches, and deletes a backend', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    const env = { ...ENV_BASE, DB: db };
    const created = await routes.get('POST /user/backends')!(
      fakeContext({
        method: 'POST',
        url: 'https://router.example.com/user/backends',
        env,
        body: { slug: 'office', baseUrl: 'https://backend.example.com', displayName: 'Office' },
      }),
    );
    expect(created.status).toBe(201);
    const list = await routes.get('GET /user/backends')!(fakeContext({ url: 'https://router.example.com/user/backends', env }));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { backends: unknown[] }).backends).toHaveLength(1);
    const one = await routes.get('GET /user/backends/:slug')!(
      fakeContext({ url: 'https://router.example.com/user/backends/office', env, params: { slug: 'office' } }),
    );
    expect(one.status).toBe(200);
    const missing = await routes.get('GET /user/backends/:slug')!(
      fakeContext({ url: 'https://router.example.com/user/backends/ghost', env, params: { slug: 'ghost' } }),
    );
    expect(missing.status).toBe(404);
    const patched = await routes.get('PATCH /user/backends/:slug')!(
      fakeContext({
        method: 'PATCH',
        url: 'https://router.example.com/user/backends/office',
        env,
        params: { slug: 'office' },
        body: { displayName: 'HQ' },
      }),
    );
    expect(patched.status).toBe(200);
    const deleted = await routes.get('DELETE /user/backends/:slug')!(
      fakeContext({ method: 'DELETE', url: 'https://router.example.com/user/backends/office', env, params: { slug: 'office' } }),
    );
    expect(deleted.status).toBe(200);
  });

  it('fans out aggregated volumes', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    registerAggregatedVolumeRoutes(app as never);
    const env = { ...ENV_BASE, DB: db };
    await routes.get('POST /user/backends')!(
      fakeContext({
        method: 'POST',
        url: 'https://router.example.com/user/backends',
        env,
        body: { slug: 'office', baseUrl: 'https://backend.example.com' },
      }),
    );
    const agg = await routes.get('GET /user/volumes')!(fakeContext({ url: 'https://router.example.com/user/volumes', env }));
    expect(agg.status).toBe(200);
    const body = (await agg.json()) as { volumes: Array<{ backend?: string }>; backends: unknown[] };
    expect(body.volumes[0]?.backend).toBe('office');
  });

  it('returns 409 when several backends match without selector', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    registerAggregatedVolumeRoutes(app as never);
    const env = { ...ENV_BASE, DB: db };
    for (const slug of ['a', 'b']) {
      await routes.get('POST /user/backends')!(
        fakeContext({
          method: 'POST',
          url: 'https://router.example.com/user/backends',
          env,
          body: { slug, baseUrl: `https://${slug}.example.com` },
        }),
      );
    }
    const res = await routes.get('GET /user/volumes/:owner/:volume')!(
      fakeContext({ url: 'https://router.example.com/user/volumes/test/photos', env, params: { owner: 'test', volume: 'photos' } }),
    );
    expect(res.status).toBe(409);
    const create = await routes.get('POST /user/volumes')!(
      fakeContext({ method: 'POST', url: 'https://router.example.com/user/volumes', env, body: { owner: 'test', name: 'x' } }),
    );
    expect(create.status).toBe(409);
  });
});
