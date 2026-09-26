import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import { clampTtl } from '@durable-dav-router/backend-runtime/kv';
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';

// KV lookaside for owner/volume → owning backend (`davRoute` domain).
//
// Bare WebDAV clients send no `?backend=` hint, so an owner mapped to N
// backends costs N parallel volume-root probes per operation. Buckets rarely
// change, so resolved owners are cached long-lived (24h default,
// `ROUTE_CACHE_TTL_SECONDS`). D1 stays authoritative: misses re-probe,
// mutations invalidate, and stale hits self-heal on forward 404/502.
//
// Keying is credential-free (`owner.toLowerCase()` + verbatim volume) —
// existence is a backend property, safe to share across requesters. Only
// `single` resolutions are stored; `ambiguous`/`unavailable`/misses never
// populate so collisions and brand-new volumes keep probing.

interface CachedRoute {
  backendId: string;
  slug: string;
  baseUrl: string;
}

// Per-isolate L1 absorbs massive sequential bursts without a KV round trip.
// Module-global on purpose: shared across requests in the same isolate.
const L1_TTL_MS = 5 * 60 * 1000;
const L1_MAX_ENTRIES = 1000;
const l1 = new Map<string, { route: CachedRoute; expiresAt: number }>();

function l1Key(owner: string, volume: string): string {
  return `${owner.toLowerCase()}\u{0}${volume}`;
}

function getL1(owner: string, volume: string): CachedRoute | null {
  const entry = l1.get(l1Key(owner, volume));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    l1.delete(l1Key(owner, volume));
    return null;
  }
  return entry.route;
}

function setL1(owner: string, volume: string, route: CachedRoute): void {
  if (l1.size >= L1_MAX_ENTRIES) {
    const oldest = l1.keys().next();
    if (!oldest.done) l1.delete(oldest.value);
  }
  l1.set(l1Key(owner, volume), { route, expiresAt: Date.now() + L1_TTL_MS });
}

function delL1(owner: string, volume: string): void {
  l1.delete(l1Key(owner, volume));
}

function clearL1(): void {
  l1.clear();
}

function routeCacheParts(owner: string, volume: string): readonly string[] {
  return [owner.toLowerCase(), volume];
}

function getRouteCacheTtlSeconds(env: unknown): number {
  try {
    return AppConfiguration.fromEnv(env).getRouteCacheTtlSeconds();
  } catch {
    return 86_400;
  }
}

function isCachedRoute(value: unknown): value is CachedRoute {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.backendId === 'string' &&
    r.backendId.length > 0 &&
    typeof r.slug === 'string' &&
    r.slug.length > 0 &&
    typeof r.baseUrl === 'string' &&
    r.baseUrl.length > 0
  );
}

async function getCachedRoute(kv: KvCache | null | undefined, owner: string, volume: string): Promise<CachedRoute | null> {
  const hit = getL1(owner, volume);
  if (hit) return hit;
  if (!kv) return null;
  try {
    const raw = await kv.getJson<unknown>('davRoute', routeCacheParts(owner, volume));
    if (!isCachedRoute(raw)) return null;
    setL1(owner, volume, raw);
    return raw;
  } catch {
    return null;
  }
}

async function putCachedRoute(
  kv: KvCache | null | undefined,
  env: unknown,
  owner: string,
  volume: string,
  route: CachedRoute,
  opts?: { ttlSeconds?: number },
): Promise<void> {
  if (!isCachedRoute(route)) return;
  setL1(owner, volume, route);
  if (!kv) return;
  try {
    const ttl = clampTtl(opts?.ttlSeconds ?? getRouteCacheTtlSeconds(env), 'davRoute');
    await kv.putJson('davRoute', routeCacheParts(owner, volume), route, ttl === undefined ? undefined : { ttlSeconds: ttl });
  } catch {
    // Best-effort population; misses just re-probe.
  }
}

async function invalidateCachedRoute(kv: KvCache | null | undefined, owner: string, volume: string): Promise<void> {
  delL1(owner, volume);
  if (!kv) return;
  try {
    await kv.del('davRoute', routeCacheParts(owner, volume));
  } catch {
    // Fail-soft; TTL + self-heal bound the stale window.
  }
}

async function purgeCachedRoutes(kv: KvCache | null | undefined): Promise<number> {
  clearL1();
  if (!kv) return 0;
  try {
    return await kv.purgePrefix('davRoute');
  } catch {
    return 0;
  }
}

// Extract the affected volume from a WebDAV `Destination` header when it
// targets this router origin (`/:owner/:volume[/...]`). Cross-origin
// destinations pass through untouched → null.
function parseDestinationVolume(routerOrigin: string, destination: string | null): { owner: string; volume: string } | null {
  if (!destination) return null;
  try {
    const destUrl = new URL(destination, routerOrigin);
    if (destUrl.origin !== routerOrigin) return null;
    const segs = destUrl.pathname.split('/').filter((s) => s.length > 0);
    if (segs.length < 2) return null;
    const owner = safeDecode(segs[0]);
    const volume = safeDecode(segs[1]);
    return !owner || !volume ? null : { owner, volume };
  } catch {
    return null;
  }
}

function safeDecode(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.trim() ? decoded : null;
  } catch {
    return segment.trim() ? segment : null;
  }
}

export {
  getCachedRoute,
  putCachedRoute,
  invalidateCachedRoute,
  purgeCachedRoutes,
  parseDestinationVolume,
  routeCacheParts,
  getRouteCacheTtlSeconds,
  isCachedRoute,
  clearL1 as clearRouteCacheL1,
};
export type { CachedRoute };
