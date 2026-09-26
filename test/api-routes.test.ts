import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';
import { registerBackendRoutes } from '../apps/api/src/workers/routes/BackendRoutes';
import { registerAggregatedVolumeRoutes } from '../apps/api/src/workers/routes/AggregatedVolumeRoutes';
import { registerUserProfileRoutes } from '../apps/api/src/workers/routes/UserRoutes';

type Row = RouterBackendRow;
type Handler = (c: FakeContext) => Promise<Response>;

/**
 * Test doubles for the `/user/*` route layer.
 *
 * The D1 double deliberately matches what SQLite does for a `WHERE col = ?`
 * comparison — an exact match on the stored, already-lowercased value — rather
 * than lowercasing both sides in JS. A more permissive fake hides exactly the
 * class of bug where a predicate is wrong in SQL but right in the double.
 */
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
  const eq = (a: unknown, b: unknown) => a === b;
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
            const found = [...rows.values()].find((r) => eq(r.owner_email, v0) && eq(r.slug_ci, v1));
            return (found ?? null) as T | null;
          }
          if (state.sql.includes('WHERE id = ?')) return (rows.get(v0) ?? null) as T | null;
          return state.sql.includes('COUNT(*)') ? ({ cnt: [...rows.values()].filter((r) => eq(r.owner_email, v0)).length } as T) : null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const [v0] = state.values as [string];
          return ({ results: state.sql.includes('backend_username_ci = ?') ? [...rows.values()].filter((r) => eq(r.backend_username_ci, v0)) as T[] : [...rows.values()].filter((r) => eq(r.owner_email, v0)) as T[] });
        },
        async run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
          const sql = state.sql;
          if (sql.startsWith('INSERT INTO router_backends')) {
            // Mirrors the real guarded insert: a `SELECT ... WHERE` supplies
            // the row only when the owner is under quota, and a duplicate is
            // dropped by the unique index rather than raising.
            const [id, ownerEmail, slug, slugCi, baseUrl, displayName, createdAt, updatedAt, ownerForQuota, max] = state.values as [
              string,
              string,
              string,
              string,
              string,
              string | null,
              number,
              number,
              string,
              number,
            ];
            const owned = [...rows.values()].filter((r) => eq(r.owner_email, ownerForQuota));
            if (owned.length >= max) return { success: true, meta: { changes: 0 } };
            if (owned.some((r) => eq(r.owner_email, ownerForQuota) && eq(r.slug_ci, slugCi))) {
              return { success: true, meta: { changes: 0 } };
            }
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
          if (sql.startsWith('UPDATE router_backends')) {
            // Column names come from the SET clause, values from the bindings
            // in the same order; the trailing binding is the id.
            const sets = sql
              .slice(sql.indexOf('SET ') + 'SET '.length)
              .split(',')
              .map((clause) => clause.split('=', 1)[0]?.trim() ?? '');
            const id = String(state.values.at(-1));
            const cur = rows.get(id);
            if (cur) {
              const patch: Record<string, unknown> = { updated_at: state.values[0] };
              sets.forEach((col, i) => {
                if (col === 'updated_at') return;
                patch[col] = state.values[i];
              });
              rows.set(id, { ...cur, ...(patch as Partial<Row>) });
            }
            return { success: true, meta: { changes: cur ? 1 : 0 } };
          }
          if (sql.startsWith('DELETE FROM router_backends')) {
            rows.delete(String(state.values[0]));
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
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
    get: (path: string, h: Handler) => routes.set(`GET ${path}`, h),
    post: (path: string, h: Handler) => routes.set(`POST ${path}`, h),
    patch: (path: string, h: Handler) => routes.set(`PATCH ${path}`, h),
    delete: (path: string, h: Handler) => routes.set(`DELETE ${path}`, h),
    on: (_m: unknown, path: string, h: Handler) => routes.set(`ON ${path}`, h),
  };
  return { app, routes };
}

/**
Optional raw body, so malformed-JSON cases are expressible.
*/
function fakeContext(opts: {
  method?: string;
  url?: string;
  env: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  email?: string;
}): FakeContext {
  const url = opts.url ?? 'https://router.example.com/';
  const headers = new Headers({ 'Content-Type': 'application/json', ...opts.headers });
  const raw = new Request(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const parsed = new URL(url);
  return {
    req: {
      raw,
      param: (n: string) => opts.params?.[n],
      query: (k: string) => parsed.searchParams.get(k) ?? undefined,
      header: (k: string) => raw.headers.get(k) ?? undefined,
      json: async () => {
        return opts.rawBody === undefined ? opts.body ?? {} : JSON.parse(opts.rawBody);
      },
    },
    env: opts.env,
    get: (k: string) => (k === 'AuthenticatedUserEmailAddress' ? (opts.email ?? 'test@example.com') : ''),
    json: (data: unknown, status = 200) => Response.json(data, { status }),
  };
}

const ENV = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'test@example.com' };

// A holder object, not a reassigned module-level binding: `beforeEach` needs
// to install a fresh stub while individual tests re-implement it.
const stubs: { fetch: ReturnType<typeof vi.fn> } = { fetch: vi.fn() };

beforeEach(() => {
  stubs.fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', stubs.fetch);
});

afterEach(() => vi.restoreAllMocks());

const call = (routes: Map<string, Handler>, key: string, ctx: FakeContext) => {
  const handler = routes.get(key);
  if (!handler) throw new Error(`No route registered for ${key}`);
  return handler(ctx);
};

describe('POST /user/backends', () => {
  const setup = () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    return { routes, env: { ...ENV, DB: db } };
  };

  it('creates a backend and returns it as camelCase', async () => {
    const { routes, env } = setup();
    const res = await call(
      routes,
      'POST /user/backends',
      fakeContext({ method: 'POST', env, body: { slug: 'office', baseUrl: 'https://b.example.com' } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe('office');
    expect(body.baseUrl).toBe('https://b.example.com');
    expect(body).toHaveProperty('lastStatus');
  });

  it('rejects a non-string slug with 400, not 500', async () => {
    // A raw cast used to let `{"slug": 1}` reach `raw.trim()` and throw.
    const { routes, env } = setup();
    for (const body of [
      { slug: 1, baseUrl: 'https://b.com' },
      { slug: {}, baseUrl: 'https://b.com' },
    ]) {
      const res = await call(routes, 'POST /user/backends', fakeContext({ method: 'POST', env, body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects a missing slug or baseUrl with 400', async () => {
    const { routes, env } = setup();
    for (const body of [{}, { slug: 'x' }, { baseUrl: 'https://b.com' }, { slug: '  ', baseUrl: 'https://b.com' }]) {
      const res = await call(routes, 'POST /user/backends', fakeContext({ method: 'POST', env, body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects a non-string displayName with 400', async () => {
    const { routes, env } = setup();
    const res = await call(
      routes,
      'POST /user/backends',
      fakeContext({ method: 'POST', env, body: { slug: 'a', baseUrl: 'https://b.com', displayName: 5 } }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const { routes, env } = setup();
    const res = await call(routes, 'POST /user/backends', fakeContext({ method: 'POST', env, rawBody: '{not json' }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-object body with 400', async () => {
    const { routes, env } = setup();
    const res = await call(routes, 'POST /user/backends', fakeContext({ method: 'POST', env, rawBody: '[1,2,3]' }));
    expect(res.status).toBe(400);
  });

  it('rejects a private or loopback baseUrl outside a development environment', async () => {
    // `ENVIRONMENT=development` allows private hosts so `wrangler dev` can point
    // at a co-located backend; the production default must refuse them.
    const { routes, env } = setup();
    const res = await call(
      routes,
      'POST /user/backends',
      fakeContext({ method: 'POST', env: { ...env, ENVIRONMENT: 'production' }, body: { slug: 'x', baseUrl: 'https://169.254.169.254' } }),
    );
    expect(res.status).toBe(400);
  });

  it('allows a loopback backend in development, and with an explicit opt-in', async () => {
    const { routes, env } = setup();
    await expect(
      call(routes, 'POST /user/backends', fakeContext({ method: 'POST', env, body: { slug: 'local', baseUrl: 'http://localhost:8787' } })),
    ).resolves.toMatchObject({ status: 201 });
    const { routes: r2, env: env2 } = setup();
    await expect(
      call(
        r2,
        'POST /user/backends',
        fakeContext({
          method: 'POST',
          env: { ...env2, ENVIRONMENT: 'production', ALLOW_PRIVATE_BACKEND_HOSTS: 'true' },
          body: { slug: 'local', baseUrl: 'http://localhost:8787' },
        }),
      ),
    ).resolves.toMatchObject({ status: 201 });
  });

  it('rejects a duplicate slug with 409 and no driver text', async () => {
    const { routes, env } = setup();
    const body = { slug: 'office', baseUrl: 'https://b.example.com' };
    await call(routes, 'POST /user/backends', fakeContext({ method: 'POST', env, body }));
    const res = await call(
      routes,
      'POST /user/backends',
      fakeContext({ method: 'POST', env, body: { ...body, baseUrl: 'https://other.example.com' } }),
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(/UNIQUE constraint/i);
  });

  it('records a liveness probe without failing creation when the backend is down', async () => {
    stubs.fetch.mockImplementation(async () => {
      throw new Error('DNS failure');
    });
    const { routes, env } = setup();
    const res = await call(
      routes,
      'POST /user/backends',
      fakeContext({ method: 'POST', env, body: { slug: 'office', baseUrl: 'https://down.example.com' } }),
    );
    // The probe is best-effort; registration must still succeed.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { lastStatus: number | null };
    expect(body.lastStatus).toBeNull();
  });
});

describe('GET /user/backends', () => {
  it('lists backends and normalizes the row shape', async () => {
    const { db, rows } = fakeDb();
    const now = Math.floor(Date.now() / 1000);
    rows.set('1', {
      id: '1',
      owner_email: 'test@example.com',
      slug: 'office',
      slug_ci: 'office',
      base_url: 'https://b.com',
      display_name: 'Office',
      created_at: now,
      updated_at: now,
      last_seen_at: null,
      last_status: null,
      backend_username: 'alice',
      backend_username_ci: 'alice',
    });
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    const res = await call(routes, 'GET /user/backends', fakeContext({ env: { ...ENV, DB: db } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backends: Array<Record<string, unknown>> };
    expect(body.backends).toHaveLength(1);
    expect(body.backends[0]).toMatchObject({ slug: 'office', baseUrl: 'https://b.com', displayName: 'Office', backendUsername: 'alice' });
  });

  it('returns an empty list rather than an error for a new account', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    const res = await call(routes, 'GET /user/backends', fakeContext({ env: { ...ENV, DB: db } }));
    expect((await res.json()) as { backends: unknown[] }).toEqual({ backends: [] });
  });
});

/**
 * A router with exactly one registered backend row. Both the CRUD suite and the
 * `/:slug/me` suite need this identical fixture; it used to be copy-pasted into
 * each, so a column added to `router_backends` had to be remembered twice.
 */
function oneBackendRow() {
  const { db, rows } = fakeDb();
  const now = Math.floor(Date.now() / 1000);
  rows.set('1', {
    id: '1',
    owner_email: 'test@example.com',
    slug: 'office',
    slug_ci: 'office',
    base_url: 'https://b.com',
    display_name: null,
    created_at: now,
    updated_at: now,
    last_seen_at: null,
    last_status: null,
    backend_username: null,
    backend_username_ci: null,
  });
  const { app, routes } = stubApp();
  registerBackendRoutes(app as never);
  return { routes, env: { ...ENV, DB: db }, rows };
}

describe('GET/PATCH/DELETE /user/backends/:slug', () => {
  const withBackend = oneBackendRow;

  it('returns 404 for an unknown slug', async () => {
    const { routes, env } = withBackend();
    const res = await call(routes, 'GET /user/backends/:slug', fakeContext({ env, params: { slug: 'nope' } }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for another account’s backend', async () => {
    // Owner scoping is enforced in the query, so a different identity simply
    // does not match.
    const { routes, env } = withBackend();
    const res = await call(
      routes,
      'GET /user/backends/:slug',
      fakeContext({ env, params: { slug: 'office' }, email: 'other@example.com' }),
    );
    expect(res.status).toBe(404);
  });

  it('updates the baseUrl', async () => {
    const { routes, env } = withBackend();
    const res = await call(
      routes,
      'PATCH /user/backends/:slug',
      fakeContext({ method: 'PATCH', env, params: { slug: 'office' }, body: { baseUrl: 'https://new.example.com' } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { baseUrl: string }).baseUrl).toBe('https://new.example.com');
  });

  it('rejects a PATCH to a private address outside a development environment', async () => {
    // Editing `base_url` is the same SSRF surface as creating one.
    const { routes, env } = withBackend();
    const res = await call(
      routes,
      'PATCH /user/backends/:slug',
      fakeContext({
        method: 'PATCH',
        env: { ...env, ENVIRONMENT: 'production' },
        params: { slug: 'office' },
        body: { baseUrl: 'https://10.0.0.1' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-string patch field with 400', async () => {
    const { routes, env } = withBackend();
    for (const body of [{ baseUrl: 5 }, { displayName: [] }]) {
      const res = await call(routes, 'PATCH /user/backends/:slug', fakeContext({ method: 'PATCH', env, params: { slug: 'office' }, body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('deletes a backend', async () => {
    const { routes, env, rows } = withBackend();
    const res = await call(routes, 'DELETE /user/backends/:slug', fakeContext({ method: 'DELETE', env, params: { slug: 'office' } }));
    expect(res.status).toBe(200);
    expect(rows.size).toBe(0);
  });

  it('returns 404 deleting an unknown backend', async () => {
    const { routes, env } = withBackend();
    const res = await call(routes, 'DELETE /user/backends/:slug', fakeContext({ method: 'DELETE', env, params: { slug: 'nope' } }));
    expect(res.status).toBe(404);
  });
});

describe('GET /user/backends/:slug/me', () => {
  const setup = oneBackendRow;

  it('returns the backend username and caches it for owner routing', async () => {
    stubs.fetch.mockImplementation(
      async () => Response.json({ username: 'alice' }, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const { routes, env, rows } = setup();
    const res = await call(routes, 'GET /user/backends/:slug/me', fakeContext({ env, params: { slug: 'office' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'office', username: 'alice' });
    // The cache is what makes unauthenticated WebDAV owner routing possible.
    expect(rows.get('1')?.backend_username).toBe('alice');
    expect(rows.get('1')?.backend_username_ci).toBe('alice');
  });

  it('forwards the caller credentials to the backend', async () => {
    stubs.fetch.mockImplementation(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { routes, env } = setup();
    await call(
      routes,
      'GET /user/backends/:slug/me',
      fakeContext({ env, params: { slug: 'office' }, headers: { Authorization: 'Bearer access-jwt', Cookie: 'CF_Authorization=abc' } }),
    );
    const init = stubs.fetch.mock.calls.at(-1)?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer access-jwt');
    expect(headers.get('Cookie')).toBe('CF_Authorization=abc');
  });

  it('passes a backend auth failure through with its own status', async () => {
    stubs.fetch.mockImplementation(async () => new Response('nope', { status: 403 }));
    const { routes, env, rows } = setup();
    const res = await call(routes, 'GET /user/backends/:slug/me', fakeContext({ env, params: { slug: 'office' } }));
    expect(res.status).toBe(403);
    // A failed lookup must not overwrite a previously cached handle.
    expect(rows.get('1')?.backend_username).toBeNull();
  });

  it('treats an unparsable body as a null username', async () => {
    stubs.fetch.mockImplementation(async () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const { routes, env } = setup();
    const res = await call(routes, 'GET /user/backends/:slug/me', fakeContext({ env, params: { slug: 'office' } }));
    expect((await res.json()) as { username: string | null }).toEqual({ slug: 'office', username: null });
  });
});

describe('GET /user/volumes fan-out', () => {
  const twoBackends = () => {
    const { db, rows } = fakeDb();
    const now = Math.floor(Date.now() / 1000);
    rows.set('1', {
      id: '1',
      owner_email: 'test@example.com',
      slug: 'a',
      slug_ci: 'a',
      base_url: 'https://a.com',
      display_name: null,
      created_at: now,
      updated_at: now,
      last_seen_at: null,
      last_status: null,
      backend_username: null,
      backend_username_ci: null,
    });
    rows.set('2', {
      id: '2',
      owner_email: 'test@example.com',
      slug: 'b',
      slug_ci: 'b',
      base_url: 'https://b.com',
      display_name: null,
      created_at: now,
      updated_at: 2,
      last_seen_at: null,
      last_status: null,
      backend_username: null,
      backend_username_ci: null,
    });
    const { app, routes } = stubApp();
    registerAggregatedVolumeRoutes(app as never);
    return { routes, env: { ...ENV, DB: db } };
  };

  it('merges volumes from every backend and tags each with its origin', async () => {
    stubs.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const origin = new URL(String(input instanceof Request ? input.url : input)).origin;
      return Response.json({ volumes: [{ name: `vol-${origin.slice(-1)}` }] });
    });
    const { routes, env } = twoBackends();
    const res = await call(routes, 'GET /user/volumes', fakeContext({ env }));
    const body = (await res.json()) as { volumes: Array<Record<string, unknown>>; backends: Array<{ slug: string; ok: boolean }> };
    expect(body.volumes).toHaveLength(2);
    expect(body.volumes.every((v) => typeof v.backend === 'string')).toBe(true);
    expect(body.backends.every((b) => b.ok)).toBe(true);
  });

  it('fails soft per backend so one outage does not blank the dashboard', async () => {
    // This is the behavior that `.catch(() => [])` destroyed: an unreachable
    // backend used to look like "you have no backends".
    stubs.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const origin = new URL(String(input instanceof Request ? input.url : input)).origin;
      return origin === 'https://b.com' ? new Response('down', { status: 502 }) : Response.json({ volumes: [{ name: 'ok' }] });
    });
    const { routes, env } = twoBackends();
    const res = await call(routes, 'GET /user/volumes', fakeContext({ env }));
    const body = (await res.json()) as { volumes: unknown[]; backends: Array<{ slug: string; ok: boolean }> };
    expect(res.status).toBe(200);
    expect(body.volumes).toHaveLength(1);
    expect(body.backends.filter((b) => b.ok)).toHaveLength(1);
  });

  it('restricts the fan-out to one backend with ?backend=', async () => {
    stubs.fetch.mockImplementation(async () => Response.json({ volumes: [] }));
    const { routes, env } = twoBackends();
    const res = await call(routes, 'GET /user/volumes', fakeContext({ env, url: 'https://router.example.com/user/volumes?backend=a' }));
    // Only the selected backend is contacted, and its status is still reported
    // so the dashboard can badge it.
    expect(stubs.fetch).toHaveBeenCalledOnce();
    const body = (await res.json()) as { backends: Array<{ slug: string }> };
    expect(body.backends).toHaveLength(1);
    expect(body.backends[0]?.slug).toBe('a');
  });

  it('returns an empty aggregate when no backend is registered', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerAggregatedVolumeRoutes(app as never);
    const res = await call(routes, 'GET /user/volumes', fakeContext({ env: { ...ENV, DB: db } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ volumes: [], backends: [] });
  });
});

describe('POST /user/volumes', () => {
  const oneBackend = () => {
    const { db, rows } = fakeDb();
    const now = Math.floor(Date.now() / 1000);
    rows.set('1', {
      id: '1',
      owner_email: 'test@example.com',
      slug: 'a',
      slug_ci: 'a',
      base_url: 'https://a.com',
      display_name: null,
      created_at: now,
      updated_at: now,
      last_seen_at: null,
      last_status: null,
      backend_username: null,
      backend_username_ci: null,
    });
    const { app, routes } = stubApp();
    registerAggregatedVolumeRoutes(app as never);
    return { routes, env: { ...ENV, DB: db }, rows };
  };

  it('proxies creation to the lone backend and caches the returned owner', async () => {
    stubs.fetch.mockImplementation(async () => Response.json({ owner: 'alice', name: 'photos' }));
    const { routes, env, rows } = oneBackend();
    const res = await call(routes, 'POST /user/volumes', fakeContext({ method: 'POST', env, body: { name: 'photos' } }));
    expect(res.status).toBe(200);
    // The owner is what WebDAV routing keys on, so the create response feeds it.
    expect(rows.get('1')?.backend_username).toBe('alice');
  });

  it('never leaks the ?backend= selector to the backend', async () => {
    stubs.fetch.mockImplementation(async () => Response.json({ owner: 'alice' }));
    const { routes, env } = oneBackend();
    await call(
      routes,
      'POST /user/volumes',
      fakeContext({ method: 'POST', env, url: 'https://router.example.com/user/volumes?backend=a', body: {} }),
    );
    expect(String(stubs.fetch.mock.calls.at(-1)?.[0])).not.toContain('backend=');
  });

  it('requires a selector when several backends exist, listing the candidates', async () => {
    const { db, rows } = fakeDb();
    const now = Math.floor(Date.now() / 1000);
    for (const [id, slug] of [
      ['1', 'a'],
      ['2', 'b'],
    ]) {
      rows.set(id, {
        id,
        owner_email: 'test@example.com',
        slug,
        slug_ci: slug,
        base_url: `https://${slug}.com`,
        display_name: null,
        created_at: now,
        updated_at: now,
        last_seen_at: null,
        last_status: null,
        backend_username: null,
        backend_username_ci: null,
      });
    }
    const { app, routes } = stubApp();
    registerAggregatedVolumeRoutes(app as never);
    const res = await call(routes, 'POST /user/volumes', fakeContext({ method: 'POST', env: { ...ENV, DB: db }, body: {} }));
    expect(res.status).toBe(409);
    // The caller needs the candidate slugs to retry, and an authenticated user
    // already knows them from the dashboard.
    const body = (await res.json()) as { Exception: { Type: string }; backends: string[] };
    expect(body.Exception.Type).toBe('Conflict');
    expect([...body.backends].sort()).toEqual(['a', 'b']);
  });

  it('accepts the X-Backend header as a selector when there is no query string', async () => {
    // Some clients cannot set a query string; the header is the documented
    // alternative and must behave identically.
    stubs.fetch.mockImplementation(async () => Response.json({ owner: 'alice' }));
    const { routes, env, rows } = oneBackend();
    const res = await call(routes, 'POST /user/volumes', fakeContext({ method: 'POST', env, body: {}, headers: { 'X-Backend': 'a' } }));
    expect(res.status).toBe(200);
    expect(rows.get('1')?.backend_username).toBe('alice');
  });

  it('reports 502 when the selected backend is unreachable', async () => {
    // A transport failure is a real answer for a proxy, and 502 keeps it
    // distinguishable from a backend-authored 404.
    stubs.fetch.mockImplementation(async () => {
      throw new Error('connection refused');
    });
    const { routes, env } = oneBackend();
    const res = await call(routes, 'POST /user/volumes', fakeContext({ method: 'POST', env, body: {} }));
    expect(res.status).toBe(502);
  });

  it('reports 504 when the selected backend times out', async () => {
    stubs.fetch.mockImplementation(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const { routes, env } = oneBackend();
    const res = await call(routes, 'POST /user/volumes', fakeContext({ method: 'POST', env, body: {} }));
    expect(res.status).toBe(504);
  });

  it('returns 404 when no backend is registered', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerAggregatedVolumeRoutes(app as never);
    const res = await call(routes, 'POST /user/volumes', fakeContext({ method: 'POST', env: { ...ENV, DB: db }, body: {} }));
    expect(res.status).toBe(404);
  });
});

describe('GET /user/me', () => {
  it('returns the authenticated email', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerUserProfileRoutes(app as never);
    const res = await call(routes, 'GET /user/me', fakeContext({ env: { ...ENV, DB: db }, email: 'user@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'user@example.com' });
  });

  it('still answers when the user row is missing', async () => {
    // The identity came from Access, so the email is authoritative even if the
    // D1 read finds nothing.
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerUserProfileRoutes(app as never);
    const res = await call(routes, 'GET /user/me', fakeContext({ env: { ...ENV, DB: db }, email: 'user@example.com' }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { email: string }).toEqual({ email: 'user@example.com' });
  });
});

describe('error responses carry the canonical envelope', () => {
  it('uses {Exception:{Type,Message}} for a 404', async () => {
    const { db } = fakeDb();
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    const res = await call(routes, 'GET /user/backends/:slug', fakeContext({ env: { ...ENV, DB: db }, params: { slug: 'nope' } }));
    const body = (await res.json()) as { Exception: { Type: string; Message: string } };
    expect(body.Exception.Type).toBe('NotFound');
    expect(typeof body.Exception.Message).toBe('string');
  });

  it('never returns a 500 with a driver message', async () => {
    // A D1 failure must be a masked 500, not a schema disclosure.
    const exploding = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('UNIQUE constraint failed: router_backends.owner_email, router_backends.slug_ci');
          },
          all: async () => {
            throw new Error('x');
          },
          run: async () => {
            throw new Error('x');
          },
        }),
      }),
    };
    const { app, routes } = stubApp();
    registerBackendRoutes(app as never);
    const res = await call(routes, 'GET /user/backends/:slug', fakeContext({ env: { ...ENV, DB: exploding }, params: { slug: 'x' } }));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toMatch(/router_backends|constraint/i);
  });
});
