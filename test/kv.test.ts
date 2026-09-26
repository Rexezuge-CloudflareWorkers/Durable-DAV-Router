import { describe, expect, it } from 'vitest';
import { KvCache } from '@durable-dav-router/backend-runtime/kv';
import { KV_DOMAINS, buildKvKey, clampTtl, utf8ByteLength, fnv1aHex, KV_MIN_TTL_SECONDS } from '@durable-dav-router/backend-runtime/kv';

/**
 * In-memory `KVNamespace` double. Records calls so tests can assert on TTL and
 * key shape, and can be told to fail so the fail-soft paths are exercised.
 */
class FakeKv {
  public readonly store = new Map<string, string>();
  public readonly puts: Array<{ key: string; ttl?: number }> = [];
  public failOn: 'get' | 'put' | 'delete' | 'list' | null = null;
  public listPageSize = 1000;

  public get calls(): number {
    return this.store.size;
  }

  private guard(op: 'get' | 'put' | 'delete' | 'list'): void {
    if (this.failOn === op) throw new Error(`KV ${op} failed`);
  }

  public async get(key: string): Promise<string | null> {
    this.guard('get');
    return this.store.get(key) ?? null;
  }

  public async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.guard('put');
    this.store.set(key, value);
    this.puts.push(options?.expirationTtl === undefined ? { key } : { key, ttl: options.expirationTtl });
  }

  public async delete(key: string): Promise<void> {
    this.guard('delete');
    this.store.delete(key);
  }

  public async list(options: {
    prefix: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    this.guard('list');
    const limit = Math.min(options.limit ?? 1000, this.listPageSize);
    return {
      keys: [...this.store.keys()]
        .filter((k) => k.startsWith(options.prefix))
        .slice(0, limit)
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}

const cache = () => new KvCache(new FakeKv() as never);
const noCache = () => new KvCache(null);

describe('KV key construction', () => {
  it('namespaces by domain and version', () => {
    expect(buildKvKey('davRoute', ['owner', 'vol'])).toBe('davRoute:v1:owner:vol');
  });

  it('encodes each segment so a separator cannot forge a key', () => {
    // An owner named "a:b" must not be able to read owner "a", volume "b".
    expect(buildKvKey('davRoute', ['a:b', 'vol'])).toBe('davRoute:v1:a%3Ab:vol');
  });

  it('trims segments and rejects an empty one', () => {
    expect(buildKvKey('davRoute', ['  owner  '])).toBe('davRoute:v1:owner');
    expect(() => buildKvKey('davRoute', [''])).toThrow(/must not be empty/);
    expect(() => buildKvKey('davRoute', [' '.repeat(3)])).toThrow(/must not be empty/);
  });

  it('requires at least one part', () => {
    expect(() => buildKvKey('davRoute', [])).toThrow(/at least one key part/);
  });

  it('rejects an unknown domain', () => {
    // A closed registry means a typo cannot silently create a new keyspace.
    expect(() => buildKvKey('nope' as never, ['a'])).toThrow(/Unknown KV domain/);
  });

  it('hashes an over-long key deterministically, so a miss just recomputes', () => {
    const parts = ['x'.repeat(600)];
    const first = buildKvKey('davRoute', parts);
    expect(first).toBe(buildKvKey('davRoute', parts));
    expect(first.length).toBeLessThan(600);
    expect(first).toMatch(/^davRoute:v1:h:[0-9a-f]{8}$/);
  });

  it('hashes distinct over-long keys to distinct keys', () => {
    expect(buildKvKey('davRoute', ['a'.repeat(600)])).not.toBe(buildKvKey('davRoute', ['b'.repeat(600)]));
  });

  it('measures UTF-8 bytes, not code units, for the size cap', () => {
    // A 2-byte character counts as 2; a 4-byte emoji as 4.
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('😀')).toBe(4);
  });

  it('produces a stable 8-hex-digit FNV-1a digest', () => {
    expect(fnv1aHex('')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1aHex('abc')).toBe(fnv1aHex('abc'));
    expect(fnv1aHex('abc')).not.toBe(fnv1aHex('abd'));
  });
});

describe('TTL clamping', () => {
  it('uses the domain default when unspecified', () => {
    expect(clampTtl(undefined, 'davRoute')).toBe(KV_DOMAINS.davRoute.ttlSeconds);
  });

  it('honours an explicit value', () => {
    expect(clampTtl(120, 'davRoute')).toBe(120);
  });

  it('floors a value below the platform minimum', () => {
    // KV rejects a TTL under 60s, so a smaller request must be raised rather
    // than passed through to fail the write.
    expect(clampTtl(1, 'davRoute')).toBe(KV_MIN_TTL_SECONDS);
    expect(clampTtl(0, 'davRoute')).toBe(KV_MIN_TTL_SECONDS);
    expect(clampTtl(-5, 'davRoute')).toBe(KV_MIN_TTL_SECONDS);
  });

  it('floors a fractional value', () => {
    expect(clampTtl(90.7, 'davRoute')).toBe(90);
  });

  it('returns undefined for a non-finite value so the write is skipped', () => {
    expect(clampTtl(NaN, 'davRoute')).toBeUndefined();
    expect(clampTtl(Infinity, 'davRoute')).toBeUndefined();
  });
});

describe('KvCache reads', () => {
  it('returns null for a missing key', async () => {
    expect(await cache().getText('davRoute', ['a', 'b'])).toBeNull();
  });

  it('round-trips text', async () => {
    const kv = new KvCache(new FakeKv() as never);
    await kv.putText('davRoute', ['a'], 'value');
    expect(await kv.getText('davRoute', ['a'])).toBe('value');
  });

  it('round-trips JSON', async () => {
    const kv = cache();
    await kv.putJson('davRoute', ['a'], { backendId: '1', slug: 's', baseUrl: 'https://x' });
    expect(await kv.getJson('davRoute', ['a'])).toEqual({ backendId: '1', slug: 's', baseUrl: 'https://x' });
  });

  it('returns null for malformed JSON rather than throwing', async () => {
    // A truncated or hand-edited entry must read as a miss so the caller
    // re-probes instead of failing the request.
    const kv = new KvCache(new FakeKv() as never);
    await kv.putText('davRoute', ['a'], '{not json');
    expect(await kv.getJson('davRoute', ['a'])).toBeNull();
  });

  it('is fail-soft when the backend throws', async () => {
    const fake = new FakeKv();
    fake.failOn = 'get';
    expect(await new KvCache(fake as never).getText('davRoute', ['a'])).toBeNull();
  });

  it('is fail-soft with no binding at all', async () => {
    expect(await noCache().getText('davRoute', ['a'])).toBeNull();
  });

  it('reports availability', () => {
    expect(cache().available).toBe(true);
    expect(noCache().available).toBe(false);
  });
});

describe('KvCache writes', () => {
  it('reports success and applies the clamped TTL', async () => {
    const fake = new FakeKv();
    const kv = new KvCache(fake as never);
    expect(await kv.putText('davRoute', ['a'], 'v', { ttlSeconds: 10 })).toBe(true);
    expect(fake.puts[0]?.ttl).toBe(KV_MIN_TTL_SECONDS);
  });

  it('applies the domain default TTL when none is given', async () => {
    // `davRoute` has a default (24h), so an unspecified TTL is not omitted —
    // it is resolved from the domain table.
    const fake = new FakeKv();
    await new KvCache(fake as never).putText('davRoute', ['a'], 'v');
    expect(fake.puts[0]?.ttl).toBe(KV_DOMAINS.davRoute.ttlSeconds);
  });

  it('omits the TTL option when the resolved TTL is undefined', async () => {
    // A non-finite requested TTL resolves to undefined, and passing
    // `{expirationTtl: undefined}` to the platform is not the same as omitting
    // the option.
    const fake = new FakeKv();
    await new KvCache(fake as never).putText('davRoute', ['a'], 'v', { ttlSeconds: NaN });
    expect(fake.puts[0]?.ttl).toBeUndefined();
    expect(fake.store.has('davRoute:v1:a')).toBe(true);
  });

  it('refuses a value over the domain size cap', async () => {
    // Storing it would fail at the platform, so skip it locally instead.
    const fake = new FakeKv();
    const kv = new KvCache(fake as never);
    expect(await kv.putText('davRoute', ['a'], 'x'.repeat(KV_DOMAINS.davRoute.maxValueBytes + 1))).toBe(false);
    expect(fake.puts).toHaveLength(0);
  });

  it('reports failure without throwing when the backend throws', async () => {
    const fake = new FakeKv();
    fake.failOn = 'put';
    expect(await new KvCache(fake as never).putText('davRoute', ['a'], 'v')).toBe(false);
  });

  it('reports failure with no binding', async () => {
    expect(await noCache().putText('davRoute', ['a'], 'v')).toBe(false);
  });

  it('refuses a value JSON cannot serialize', async () => {
    // A circular structure must not take down the request that triggered a
    // best-effort cache write.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await cache().putJson('davRoute', ['a'], circular)).toBe(false);
  });

  it('returns false when JSON.stringify yields undefined', async () => {
    expect(await cache().putJson('davRoute', ['a'], undefined)).toBe(false);
  });
});

describe('KvCache deletes and purge', () => {
  it('deletes a key', async () => {
    const kv = cache();
    await kv.putText('davRoute', ['a'], 'v');
    await kv.del('davRoute', ['a']);
    expect(await kv.getText('davRoute', ['a'])).toBeNull();
  });

  it('is fail-soft when delete throws', async () => {
    const fake = new FakeKv();
    fake.failOn = 'delete';
    await expect(new KvCache(fake as never).del('davRoute', ['a'])).resolves.toBeUndefined();
  });

  it('purges every key under a prefix and reports the count', async () => {
    const fake = new FakeKv();
    const kv = new KvCache(fake as never);
    for (const vol of ['a', 'b', 'c']) await kv.putJson('davRoute', ['owner', vol], { backendId: '1' });
    expect(await kv.purgePrefix('davRoute')).toBe(3);
    expect(fake.store.size).toBe(0);
  });

  it('purges only under the requested prefix when parts are given', async () => {
    const fake = new FakeKv();
    const kv = new KvCache(fake as never);
    await kv.putJson('davRoute', ['alice', 'v'], { backendId: '1' });
    await kv.putJson('davRoute', ['bob', 'v'], { backendId: '2' });
    expect(await kv.purgePrefix('davRoute', ['alice'])).toBe(1);
    expect(fake.store.size).toBe(1);
  });

  it('deletes every key across multiple full pages', async () => {
    // `purgePrefix` requests 1000 per page and only stops when a page comes
    // back short, so a domain larger than one page needs the loop to work.
    // Restarting the list after each page is what makes it terminate; advancing
    // a cursor past already-deleted keys would skip entries.
    const fake = new FakeKv();
    const kv = new KvCache(fake as never);
    const total = 1200;
    for (let i = 0; i < total; i += 1) await kv.putJson('davRoute', ['owner', `v${i}`], { backendId: '1' });
    expect(await kv.purgePrefix('davRoute')).toBe(total);
    expect(fake.store.size).toBe(0);
  });

  it('stops at the page cap rather than looping forever', async () => {
    // Bounded work per call: a pathological keyspace is purged incrementally
    // across calls instead of holding the request open.
    const fake = new FakeKv();
    const kv = new KvCache(fake as never);
    const total = 12_000;
    for (let i = 0; i < total; i += 1) await kv.putJson('davRoute', ['owner', `v${i}`], { backendId: '1' });
    const deleted = await kv.purgePrefix('davRoute');
    expect(deleted).toBe(10_000);
    expect(deleted).toBeLessThan(total);
    // A follow-up call continues where the first stopped.
    expect(await kv.purgePrefix('davRoute')).toBe(2000);
    expect(fake.store.size).toBe(0);
  });

  it('is fail-soft when list throws', async () => {
    const fake = new FakeKv();
    fake.failOn = 'list';
    expect(await new KvCache(fake as never).purgePrefix('davRoute')).toBe(0);
  });

  it('is a no-op with no binding', async () => {
    expect(await noCache().purgePrefix('davRoute')).toBe(0);
  });
});
