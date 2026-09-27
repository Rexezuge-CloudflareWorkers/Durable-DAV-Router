import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRouteCacheL1,
  getCachedRoute,
  getRouteCacheTtlSeconds,
  invalidateCachedRoute,
  invalidateCachedRouteIfPresent,
  isCachedRoute,
  parseDestinationVolume,
  putCachedRoute,
  purgeCachedRoutes,
  routeCacheParts,
  sameRoute,
} from '@durable-dav-router/backend-services/router';
import { buildKvKey, clampTtl, KV_DOMAINS, KvCache } from '@durable-dav-router/backend-runtime/kv';

/**
`KVNamespace` double that counts operations, so a test can assert cost.
*/
function countingKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const ops = { get: 0, put: 0, delete: 0 };
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
      return Promise.resolve({
        keys: [...store.keys()].filter((name) => name.startsWith(options.prefix)).map((name) => ({ name })),
        list_complete: true,
      });
    },
  };
}

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

const ROUTE = { backendId: '1', slug: 'a', baseUrl: 'https://a.example.com' };

describe('davRoute KV domain', () => {
  it('is long-lived for rarely-changing buckets', () => {
    expect(KV_DOMAINS.davRoute.ttlSeconds).toBe(86_400);
    expect(KV_DOMAINS.davRoute.maxValueBytes).toBe(4096);
  });
  it('builds stable keys and clamps TTL to the 60s floor', () => {
    expect(buildKvKey('davRoute', ['owner', 'vol'])).toBe('davRoute:v1:owner:vol');
    expect(clampTtl(undefined, 'davRoute')).toBe(86_400);
    expect(clampTtl(5, 'davRoute')).toBe(60);
  });
});

describe('RouteCacheService', () => {
  beforeEach(() => {
    clearRouteCacheL1();
  });

  it('lowercases the owner segment of the key', () => {
    expect(routeCacheParts('Starfish', 'test123')).toEqual(['starfish', 'test123']);
  });

  it('validates cached shapes', () => {
    expect(isCachedRoute(ROUTE)).toBe(true);
    expect(isCachedRoute(null)).toBe(false);
    expect(isCachedRoute({ slug: 'a', baseUrl: 'https://a.example.com' })).toBe(false);
    expect(isCachedRoute({ backendId: '', slug: 'a', baseUrl: 'https://a.example.com' })).toBe(false);
  });

  it('reads TTL from env with a 24h default', () => {
    expect(getRouteCacheTtlSeconds({})).toBe(86_400);
    expect(getRouteCacheTtlSeconds({ ROUTE_CACHE_TTL_SECONDS: '3600' })).toBe(3600);
    expect(getRouteCacheTtlSeconds({ ROUTE_CACHE_TTL_SECONDS: 'banana' })).toBe(86_400);
  });

  it('misses fail-soft without a binding, L1 still serves the isolate', async () => {
    await expect(getCachedRoute(null, 'owner', 'vol')).resolves.toBeNull();
    await putCachedRoute(null, {}, 'owner', 'vol', ROUTE);
    await expect(getCachedRoute(null, 'owner', 'vol')).resolves.toEqual(ROUTE);
  });

  it('round-trips through KV and rejects corrupt entries', async () => {
    const raw = makeFakeKv();
    const kv = new KvCache(raw as never);
    await putCachedRoute(kv, {}, 'Owner', 'Vol', ROUTE);
    // Owner is canonicalized: mixed-case lookup hits the same KV entry.
    clearRouteCacheL1();
    await expect(getCachedRoute(kv, 'owner', 'Vol')).resolves.toEqual(ROUTE);
    const bad = new KvCache(makeFakeKv({ [buildKvKey('davRoute', ['owner', 'bad'])]: 'not-json{' }) as never);
    await expect(getCachedRoute(bad, 'owner', 'bad')).resolves.toBeNull();
    const wrongShape = new KvCache(makeFakeKv({ [buildKvKey('davRoute', ['owner', 'ws'])]: JSON.stringify({ nope: 1 }) }) as never);
    await expect(getCachedRoute(wrongShape, 'owner', 'ws')).resolves.toBeNull();
  });

  it('invalidates single keys and purges the domain', async () => {
    const kv = new KvCache(makeFakeKv() as never);
    await putCachedRoute(kv, {}, 'owner', 'one', ROUTE);
    await putCachedRoute(kv, {}, 'owner', 'two', ROUTE);
    await invalidateCachedRoute(kv, 'owner', 'one');
    await expect(getCachedRoute(kv, 'owner', 'one')).resolves.toBeNull();
    await expect(getCachedRoute(kv, 'owner', 'two')).resolves.toEqual(ROUTE);
    await expect(purgeCachedRoutes(kv)).resolves.toBe(1);
    await expect(getCachedRoute(kv, 'owner', 'two')).resolves.toBeNull();
  });
});

describe('sameRoute', () => {
  // The whole write policy for a stale entry rests on this comparison, so it
  // has to track the route's meaning and nothing else.
  it('treats the same backend and origin as unchanged', () => {
    expect(sameRoute(ROUTE, { ...ROUTE })).toBe(true);
  });

  it('ignores the slug, which is not part of the route', () => {
    // A rename leaves the resolution identical, so it must not cost a write.
    expect(sameRoute(ROUTE, { ...ROUTE, slug: 'renamed' })).toBe(true);
  });

  it('separates a different backend and a different origin', () => {
    expect(sameRoute(ROUTE, { ...ROUTE, backendId: '2' })).toBe(false);
    expect(sameRoute(ROUTE, { ...ROUTE, baseUrl: 'https://b.example.com' })).toBe(false);
  });
});

describe('invalidateCachedRouteIfPresent', () => {
  beforeEach(() => {
    clearRouteCacheL1();
  });

  it('spends no delete on a key it never stored', async () => {
    // A cross-volume sync MOVEs into directories the router never cached, and
    // the free plan allots 1,000 deletes against 100,000 reads — a read settles
    // "is it there?" at a hundredth of the price.
    const raw = countingKv();
    const kv = new KvCache(raw as never);
    await invalidateCachedRouteIfPresent(kv, 'owner', 'nevercached');
    expect(raw.ops.delete).toBe(0);
    expect(raw.ops.get).toBe(1);
  });

  it('deletes a key that is there', async () => {
    const raw = countingKv();
    const kv = new KvCache(raw as never);
    await putCachedRoute(kv, {}, 'owner', 'present', ROUTE);
    clearRouteCacheL1();
    const before = raw.ops.delete;
    await invalidateCachedRouteIfPresent(kv, 'owner', 'present');
    expect(raw.ops.delete).toBe(before + 1);
    await expect(getCachedRoute(kv, 'owner', 'present')).resolves.toBeNull();
  });

  it('drops the L1 entry too, since a fresh isolate cannot', async () => {
    const raw = countingKv();
    const kv = new KvCache(raw as never);
    await putCachedRoute(kv, {}, 'owner', 'l1only', ROUTE);
    await invalidateCachedRouteIfPresent(kv, 'owner', 'l1only');
    await expect(getCachedRoute(kv, 'owner', 'l1only')).resolves.toBeNull();
  });

  it('is fail-soft with no binding, and spends no delete when the read throws', async () => {
    const raw = countingKv();
    raw.get = () => Promise.reject(new Error('KV get failed'));
    await expect(invalidateCachedRouteIfPresent(new KvCache(raw as never), 'owner', 'vol')).resolves.toBeUndefined();
    expect(raw.ops.delete).toBe(0);
    await expect(invalidateCachedRouteIfPresent(null, 'owner', 'vol')).resolves.toBeUndefined();
  });
});

describe('parseDestinationVolume', () => {
  const origin = 'https://router.example.com';
  it('extracts owner/volume from same-origin destinations', () => {
    expect(parseDestinationVolume(origin, 'https://router.example.com/a/b/c')).toEqual({ owner: 'a', volume: 'b' });
    expect(parseDestinationVolume(origin, '/a/b')).toEqual({ owner: 'a', volume: 'b' });
    expect(parseDestinationVolume(origin, 'https://router.example.com/a%20x/b?backend=solo')).toEqual({ owner: 'a x', volume: 'b' });
  });
  it('rejects cross-origin, short, and empty destinations', () => {
    expect(parseDestinationVolume(origin, 'https://other.example.com/a/b')).toBeNull();
    expect(parseDestinationVolume(origin, 'https://router.example.com/onlyone')).toBeNull();
    expect(parseDestinationVolume(origin, null)).toBeNull();
    expect(parseDestinationVolume(origin, '')).toBeNull();
  });
});
