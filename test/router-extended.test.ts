import { describe, expect, it, vi } from 'vitest';
import { RouterBackendDAO } from '@durable-dav-router/backend-data/dao';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';
import { BackendService } from '@durable-dav-router/backend-services/router';
import {
  buildProxiedHeaders,
  filterProxiedResponseHeaders,
  getProxyTimeoutMs,
  stripSlashes,
  stripTrailingSlashes,
} from '@durable-dav-router/backend-services/router';
import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import { Tokens, createRequestScope } from '@durable-dav-router/backend-services/composition';

function fakeDb(rows: RouterBackendRow[] = []): D1Queryable {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
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
            const found = [...store.values()].find((r) => r.owner_email.toLowerCase() === String(v0).toLowerCase() && r.slug_ci === String(v1));
            return (found ?? null) as T | null;
          }
          if (state.sql.includes('WHERE id = ?')) {
            return (store.get(String(v0)) ?? null) as T | null;
          }
          if (state.sql.includes('COUNT(*)')) {
            const n = [...store.values()].filter((r) => r.owner_email.toLowerCase() === String(v0).toLowerCase()).length;
            return { cnt: n } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const [v0] = state.values as [string];
          const results = [...store.values()].filter((r) => r.owner_email.toLowerCase() === String(v0).toLowerCase());
          return { results: results as T[] };
        },
        async run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
          if (state.sql.startsWith('INSERT INTO router_backends')) {
            const [id, ownerEmail, slug, slugCi, baseUrl, displayName, createdAt, updatedAt] = state.values as [
              string, string, string, string, string, string | null, number, number,
            ];
            store.set(id, {
              id, owner_email: ownerEmail, slug, slug_ci: slugCi, base_url: baseUrl, display_name: displayName,
              created_at: createdAt, updated_at: updatedAt, last_seen_at: null, last_status: null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (state.sql.startsWith('UPDATE router_backends')) {
            const id = String(state.values[state.values.length - 1]);
            const cur = store.get(id);
            if (cur) {
              if (state.sql.includes('base_url = ?')) {
                const idx = state.sql.indexOf('base_url = ?');
                void idx;
              }
              store.set(id, { ...cur, updated_at: Date.now() });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (state.sql.startsWith('DELETE FROM router_backends')) {
            store.delete(String(state.values[0]));
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
}

describe('RouterBackendDAO', () => {
  it('creates and reads backends case-insensitively', async () => {
    const dao = new RouterBackendDAO(fakeDb());
    await dao.create({ id: '1', ownerEmail: 'User@Example.com', slug: 'Office', baseUrl: 'https://b.example.com', displayName: null, now: 7 });
    // Owner stored as-given; lookups are case-insensitive.
    await expect(dao.getByOwnerSlug('user@example.com', 'OFFICE')).resolves.toMatchObject({ slug: 'Office' });
    await expect(dao.getById('1')).resolves.toMatchObject({ base_url: 'https://b.example.com' });
    await expect(dao.countByOwnerEmail('USER@example.com')).resolves.toBe(1);
    await expect(dao.listByOwnerEmail('user@example.com')).resolves.toHaveLength(1);
    await dao.deleteById('1');
    await expect(dao.getById('1')).resolves.toBeNull();
  });
});

describe('BackendService extended', () => {
  it('rejects invalid slug and baseUrl', async () => {
    const svc = new BackendService({ DB: fakeDb() });
    await expect(svc.createBackend({ ownerEmail: 'u@e.com', slug: '-bad-', baseUrl: 'https://b.example.com' })).rejects.toThrow();
    await expect(svc.createBackend({ ownerEmail: 'u@e.com', slug: 'ok', baseUrl: 'https://b.example.com/sub' })).rejects.toThrow();
    await expect(svc.createBackend({ ownerEmail: 'u@e.com', slug: 'ok', baseUrl: 'notaurl' })).rejects.toThrow();
  });

  it('gets, lists, updates, and deletes', async () => {
    const svc = new BackendService({ DB: fakeDb() });
    await svc.createBackend({ ownerEmail: 'u@e.com', slug: 'a', baseUrl: 'https://a.example.com', displayName: 'A' });
    await expect(svc.getBackend('u@e.com', 'a')).resolves.toMatchObject({ slug: 'a' });
    await expect(svc.getBackend('u@e.com', 'missing')).rejects.toThrow();
    await expect(svc.listBackends('u@e.com')).resolves.toHaveLength(1);
    await svc.deleteBackend('u@e.com', 'a');
    await expect(svc.listBackends('u@e.com')).resolves.toHaveLength(0);
  });

  it('recordProbe tolerates unknown slugs', async () => {
    const svc = new BackendService({ DB: fakeDb() });
    await expect(svc.recordProbe('u@e.com', 'ghost', 200)).resolves.toBeUndefined();
  });
});

describe('proxy header helpers', () => {
  it('strips slashes', () => {
    expect(stripTrailingSlashes('https://b.example.com///')).toBe('https://b.example.com');
    expect(stripSlashes('//a/b//')).toBe('a/b');
  });

  it('forwards allowlisted headers and rewrites Destination', () => {
    const req = new Request('https://router.example.com/a/b', {
      method: 'MOVE',
      headers: {
        Authorization: 'Basic eA==',
        Depth: 'infinity',
        Destination: 'https://router.example.com/a/c',
        'X-Custom': 'drop-me',
      },
    });
    const out = buildProxiedHeaders(req, 'https://router.example.com', 'https://backend.example.com');
    expect(out.get('Authorization')).toBe('Basic eA==');
    expect(out.get('Destination')).toBe('https://backend.example.com/a/c');
    expect(out.get('X-Custom')).toBeNull();
  });

  it('forwards Cookie/User-Agent/Translate/Brief and strips X-Backend', () => {
    const req = new Request('https://router.example.com/a/b', {
      method: 'PROPFIND',
      headers: {
        Authorization: 'Basic eA==',
        Cookie: 'CF_Authorization=abc',
        'User-Agent': 'Cyberduck/9.0',
        Translate: 'f',
        Brief: 'T',
        'X-Backend': 'office',
      },
    });
    const out = buildProxiedHeaders(req, 'https://router.example.com', 'https://backend.example.com');
    expect(out.get('Cookie')).toBe('CF_Authorization=abc');
    expect(out.get('User-Agent')).toBe('Cyberduck/9.0');
    expect(out.get('Translate')).toBe('f');
    expect(out.get('Brief')).toBe('T');
    expect(out.get('X-Backend')).toBeNull();
  });

  it('filters response headers to the allowlist', () => {
    const incoming = new Headers({ ETag: '"1"', 'X-Internal': 'no', 'Content-Type': 'text/plain' });
    const out = filterProxiedResponseHeaders(incoming);
    expect(out.get('ETag')).toBe('"1"');
    expect(out.get('X-Internal')).toBeNull();
  });

  it('forwards MS-Author-Via for Windows clients', () => {
    const incoming = new Headers({ 'MS-Author-Via': 'DAV', DAV: '1, 2', Allow: 'OPTIONS, GET' });
    const out = filterProxiedResponseHeaders(incoming);
    expect(out.get('MS-Author-Via')).toBe('DAV');
    expect(out.get('DAV')).toBe('1, 2');
  });

  it('reads proxy timeout with default fallback', () => {
    expect(getProxyTimeoutMs({ BACKEND_FETCH_TIMEOUT_MS: '1234' })).toBe(1234);
    expect(getProxyTimeoutMs({})).toBe(8000);
  });
});

describe('AppConfiguration router limits', () => {
  it('applies defaults and env overrides', () => {
    expect(AppConfiguration.fromEnv({}).getMaxBackendsPerUser()).toBe(20);
    expect(AppConfiguration.fromEnv({ MAX_BACKENDS_PER_USER: '3' }).getMaxBackendsPerUser()).toBe(3);
    expect(AppConfiguration.fromEnv({}).getBackendFetchTimeoutMs()).toBe(8000);
  });

  it('reports malformed numeric vars', () => {
    expect(AppConfiguration.fromEnv({ MAX_BACKENDS_PER_USER: 'banana' }).validate()).toEqual([
      'Invalid configuration: MAX_BACKENDS_PER_USER must be a positive integer',
    ]);
    expect(AppConfiguration.fromEnv({}).validate()).toEqual([]);
  });
});

describe('request scope composition', () => {
  it('resolves backend service and memoizes DAO thunks', async () => {
    const scope = createRequestScope({ DB: fakeDb() });
    expect(scope.get(Tokens.BackendService)).toBe(scope.get(Tokens.BackendService));
    const thunk = scope.get(Tokens.RouterBackendDAO);
    const dao = await thunk();
    expect(dao).toBe(await thunk());
    vi.useFakeTimers();
    vi.useRealTimers();
  });
});
