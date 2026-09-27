// Reconciling the `davRoute` lookaside after a request found a cached entry
// untrustworthy.
//
// Split out of `RouterDavProxyRoutes` because the write policy is a budgeting
// problem, not a routing one: the Workers KV free plan allots 1,000 writes and
// 1,000 deletes per day against 100,000 reads, so every operation spent here has
// to be one the answer actually changed. It is also the part with a failure mode
// no status-code assertion can see — a client that 404s in a loop spent a delete
// plus a put of the identical value on *every* request and exhausted the whole
// daily budget in around 40 minutes, while every response stayed correct.
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';
import { invalidateCachedRoute, putCachedRoute, sameRoute } from '@durable-dav-router/backend-services/router';
import type { CachedRoute } from '@durable-dav-router/backend-services/router';

type ProxyContext = { req: { raw: Request }; env: Env; executionCtx?: unknown };

type BackendRoute = { id?: unknown; slug: string; base_url: string };

// Fire-and-forget cache writes: `waitUntil` when the runtime provides it,
// otherwise a detached promise. L1 updates inside the cache helpers run
// synchronously on call, so the next request in this isolate already hits.
function runInBackground(c: ProxyContext, promise: Promise<unknown>, label: string): void {
  const swallow = (error: unknown): undefined => {
    // Never let a cache write break the request, but do not lose the signal
    // either: a failed invalidation leaves a stale route in place for the whole
    // TTL, and a failed populate is invisible until a slow request is traced.
    console.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  };
  try {
    const ctx = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(promise.catch(swallow));
      return;
    }
  } catch {
    // fall through to detached promise
  }
  void promise.catch(swallow);
}

function cachedBackendId(backend: { id?: unknown; slug: string }): string {
  return typeof backend.id === 'string' && backend.id.length > 0 ? backend.id : backend.slug;
}

function toCachedRoute(backend: BackendRoute): CachedRoute {
  return { backendId: cachedBackendId(backend), slug: backend.slug, baseUrl: backend.base_url };
}

// A cached entry this request consulted and found untrustworthy, plus why.
//
// `proven` separates a fact from a hint. D1 disagreeing with the entry (the
// backend is gone, or its `base_url` was edited) settles the question on its
// own. A 404/410 from the origin does not: the origin may 404 for reasons that
// have nothing to do with ownership, which is exactly why a non-`proven` entry
// is only rewritten when the re-resolution actually disagrees with it.
type StaleRoute = { route: CachedRoute; proven: boolean };

// Replace a stale entry, or discover there is nothing to replace.
//
// `put` is an upsert, so overwriting a stale value needs no `delete` first —
// spending two KV operations to move a key to the value it already held is what
// exhausted the free plan's 1,000 writes + 1,000 deletes per day, since a
// client that 404s in a loop pays this on every single request.
//
// The one route that gets written: it is the only resolution that skipped a
// probe fan-out, which is the only reason the lookaside exists. A lone backend
// resolves without probing, so caching it would store a value the same request's
// D1 read already produced.
function replaceStaleRoute(
  c: ProxyContext,
  kv: KvCache | null,
  stale: StaleRoute | null,
  owner: string,
  volume: string,
  replacement: BackendRoute,
): void {
  const next = toCachedRoute(replacement);
  if (stale && sameRoute(stale.route, next)) return;
  runInBackground(c, putCachedRoute(kv, c.env, owner, volume, next), 'route cache replace');
}

// Drop a stale entry that nothing replaces: no backend claims the volume, the
// owners collided, or the re-resolution names a different backend on a path that
// does not cache (a lone backend — see `resolveBackend`'s one-candidate
// short-circuit). `replacement` is the route this request resolved to, or null
// when there is none; passing a route equal to the stale one is a 0-operation
// no-op, which is what keeps a volume that has genuinely gone from costing a
// delete per request.
function evictStaleRoute(
  c: ProxyContext,
  kv: KvCache | null,
  stale: StaleRoute | null,
  owner: string,
  volume: string,
  replacement: BackendRoute | null,
): void {
  if (!stale) return;
  if (replacement && sameRoute(stale.route, toCachedRoute(replacement))) return;
  runInBackground(c, invalidateCachedRoute(kv, owner, volume), 'route cache invalidate');
}

export { evictStaleRoute, replaceStaleRoute, runInBackground };
export type { ProxyContext, StaleRoute };
