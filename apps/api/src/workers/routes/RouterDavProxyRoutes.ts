import type { Hono } from 'hono';
import {
  buildProxiedHeaders,
  forwardDavRequest,
  getCachedRoute,
  getProxyTimeoutMs,
  invalidateCachedRoute,
  invalidateCachedRouteIfPresent,
  joinBackendUrlWithoutSelector,
  parseDestinationVolume,
  probeCandidateBackends,
  putCachedRoute,
  stripSlashes,
} from '@durable-dav-router/backend-services/router';
import type { BackendService, CachedRoute } from '@durable-dav-router/backend-services/router';
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';
import { DatabaseError } from '@durable-dav-router/backend-errors';
import { SUPPORT_METHODS, applyCors } from '@durable-dav-router/webdav';
import { BaseRoute, handleRoute } from '@/endpoints/IBaseRoute';
import { resolveBackendService, resolveKvCache } from './scopeAccess';
import type { RouteContext, RouterEnv } from '@/requestContext';
import { runInBackground } from './routeCacheReconcile';
import type { ProxyContext, StaleRoute } from './routeCacheReconcile';
import { decideOwnerRoute } from './ownerRoute';
import type { CacheAction, RevalidationVerdict, RoutableBackend } from './ownerRoute';

type App = Hono<RouterEnv>;

// Forward statuses that mark a cached resolution stale: the volume moved or was
// deleted from the origin we last saw it on.
//
// 502/504 are deliberately excluded. They mean "that origin is unreachable or
// timed out", which says nothing about whether the route is stale — the D1
// revalidation below already catches a deleted or repointed backend — and
// treating them as staleness used to send every transient backend blip through
// a second full forward.
const STALE_CACHED_STATUSES = new Set([404, 410]);

// Methods that may be replayed after a stale cached route is discovered.
// Re-sending a consumed request body would write a truncated (or empty) file,
// and a mutation that succeeded before the response was lost would be applied
// twice — once to each of two different backends.
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND']);

/**
What the decision is applied to, so the applier needs nothing else.
*/
type CacheTarget = { c: ProxyContext; kv: KvCache | null; owner: string; volume: string };

function applyCacheAction(action: CacheAction, target: CacheTarget, backend?: RoutableBackend): void {
  const { c, kv, owner, volume } = target;
  if (action === 'replace' && backend) {
    // `put` is an upsert, so overwriting a stale value needs no `delete` first;
    // spending two operations to move a key to the value it already held is what
    // exhausted the free plan's daily allowance.
    runInBackground(c, putCachedRoute(kv, c.env, owner, volume, toCachedRoute(backend)), 'route cache replace');
    return;
  }
  if (action === 'evict') {
    runInBackground(c, invalidateCachedRoute(kv, owner, volume), 'route cache invalidate');
  }
}

function toCachedRoute(backend: RoutableBackend): CachedRoute {
  const backendId = typeof backend.id === 'string' && backend.id.length > 0 ? backend.id : backend.slug;
  return { backendId, slug: backend.slug, baseUrl: backend.base_url };
}

/**
 * Revalidate a cached entry against D1.
 *
 * Returns `unknown` — rather than throwing — for a genuine database fault, which
 * is what keeps an unverifiable entry from being treated as a disproven one.
 * `isMissingSchemaError` has already degraded to `null` inside `d1Read`, so a
 * `DatabaseError` reaching here means the read could not be completed at all.
 */
async function revalidateCachedRoute(service: BackendService, cached: CachedRoute): Promise<RevalidationVerdict> {
  try {
    const current = await service.findBackendById(cached.backendId);
    // A missing row and an edited `base_url` are both D1 speaking, not a fault,
    // so both settle the entry.
    return current && current.base_url === cached.baseUrl ? { kind: 'confirmed', backend: current } : { kind: 'disproved' };
  } catch (error) {
    if (error instanceof DatabaseError) return { kind: 'unknown' };
    throw error;
  }
}

/**
Read the cached route for this request, if any. Fail-soft: a KV error is a miss.
*/
async function readCachedRoute(kv: KvCache | null, owner: string, volume: string): Promise<CachedRoute | null> {
  try {
    return await getCachedRoute(kv, owner, volume);
  } catch {
    return null;
  }
}

const handleProxy = handleRoute(async (c: RouteContext, owner: string, volume: string, inner: string, trailingSlash: boolean) => {
  const method = c.req.raw.method;
  if (!SUPPORT_METHODS.includes(method)) {
    return applyCors(new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', ') } }), c.req.raw);
  }
  const scope = BaseRoute.getScope(c);
  const kv = resolveKvCache(scope);
  const service = resolveBackendService(scope);
  const explicit = explicitBackendSlug(c.req.raw);
  const target: CacheTarget = { c, kv, owner, volume };
  const timeoutMs = getProxyTimeoutMs(c.env);

  // KV lookaside: bare client URLs repeat the same owner/volume for every
  // operation of a sync run. A hit skips both the D1 owner lookup and the N
  // parallel volume-root probes. Trust + self-heal: a stale hit surfaces as a
  // forward 404/410, which re-resolves.
  //
  // `stale` records an entry this request must reconcile before responding, so
  // the write decision lands *after* the re-resolution and can see whether the
  // route actually changed. Deciding up front meant deleting on the way in and
  // writing the same value on the way out.
  const cached = explicit ? null : await readCachedRoute(kv, owner, volume);
  let stale: StaleRoute | null = null;
  let verdict: RevalidationVerdict | null = null;

  if (cached) {
    verdict = await revalidateCachedRoute(service, cached);
    if (verdict.kind === 'confirmed') {
      // The revalidation is the authority, so the owner lookup and the probe
      // fan-out are both skipped.
      const res = await forwardTo(c, verdict.backend, owner, volume, inner, trailingSlash, timeoutMs);
      if (!STALE_CACHED_STATUSES.has(res.status)) {
        trackVolumeMutation(c, kv, owner, volume, inner, res.status);
        return res;
      }
      // A 404/410 from the origin is a *hint*, never proof on its own: it may
      // be that sub-resource's answer (a client walking a tree 404s constantly
      // — stale `If` headers, files removed on another device, resources a
      // partial sync has not recreated yet) rather than the volume's. The
      // re-resolution below decides, and it does so by *comparing* — if the
      // volume resolves to the backend already cached, the entry was right and
      // every write would be churn. That is what used to happen on each of those
      // 404s: a delete followed by a put of the identical value, forever.
      await res.body?.cancel().catch(() => undefined);
      if (!REPLAY_SAFE_METHODS.has(method)) {
        // The origin is authoritative for this request; evict so the *next*
        // one re-resolves, but do not replay this request against a second
        // backend. There is no re-resolution to compare against, so this is
        // the one eviction that cannot be turned into a no-op.
        applyCacheAction('evict', target);
        return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
      }
      stale = { route: cached, proven: false };
      // The revalidation said nothing useful, so fall through to the fan-out.
      verdict = null;
    } else if (verdict.kind === 'disproved') {
      // D1 disagrees, so the entry is wrong whatever the origin answers.
      stale = { route: cached, proven: true };
    }
    // `unknown` leaves the entry merely suspect: it has neither been confirmed
    // nor disproved, and the authoritative owner lookup below decides.
  }

  // WebDAV proxy is owner-routed, not requester-routed. Native clients only
  // send per-bucket Basic `Authorization` — they never carry Cloudflare Access
  // JWT — so requiring an Access identity here breaks every client (401).
  // Usernames are per-backend (one account may hold different handles on
  // different backends); the router keeps only a `backend_username` cache per
  // registered backend and routes on it, which is why the path segment named
  // `owner` below is not the router account and is never resolved against
  // `users`. The backend enforces public-vs-private itself with the
  // verbatim-proxied credentials.
  //
  // Not wrapped in a `.catch`: an unreachable database is not the same answer as
  // an unknown handle, and this route has no authenticated caller to soften the
  // distinction. `[]` here answered `404` for volumes that exist — which a
  // native client reads as "the bucket is gone", and a sync acts on — while
  // `d1Read` had already refused to make the same substitution one layer up.
  // Only a missing schema degrades, and it degrades inside `d1Read`.
  const candidates = await service.listByBackendUsername(owner);
  const ambiguous = candidates.length > 1 && (explicit ?? '') === '';
  const probe = ambiguous
    ? await probeCandidateBackends({
        candidates,
        volumePath: `/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`,
        incoming: c.req.raw,
        routerOrigin: new URL(c.req.raw.url).origin,
        timeoutMs,
      }).catch(() => ({ kind: 'unavailable' }) as const)
    : null;

  const decision = decideOwnerRoute({ stale, verdict, candidates, explicit, probe });
  applyCacheAction(decision.cache, target, decision.kind === 'forward' ? decision.backend : undefined);

  switch (decision.kind) {
    case 'not-found': {
      return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
    }
    case 'unavailable': {
      return applyCors(new Response('Backend unreachable', { status: 502 }), c.req.raw);
    }
    case 'conflict': {
      // A genuine collision (same volume on several backends). Unauthenticated
      // WebDAV callers get no slug enumeration — they already know their slugs
      // from the authenticated dashboard (`/user/volumes`).
      return applyCors(
        Response.json({ Exception: { Type: 'Conflict', Message: 'Multiple backends match; retry with ?backend=<slug>' } }, { status: 409 }),
        c.req.raw,
      );
    }
    default: {
      const res = await forwardTo(c, decision.backend, owner, volume, inner, trailingSlash, timeoutMs);
      trackVolumeMutation(c, kv, owner, volume, inner, res.status);
      return res;
    }
  }
});

/**
Read the backend selector: query string first, then `X-Backend`.
*/
function explicitBackendSlug(request: Request): string | null {
  try {
    const q = new URL(request.url).searchParams.get('backend');
    if (q?.trim()) return q.trim();
  } catch {
    // A malformed URL falls through to the header; the caller cannot set one on
    // a request whose URL does not parse, so this answers `null`.
  }
  const header = request.headers.get('X-Backend');
  return header?.trim() ? header.trim() : null;
}

async function forwardTo(
  c: RouteContext,
  backend: { base_url: string },
  owner: string,
  volume: string,
  inner: string,
  trailingSlash: boolean,
  timeoutMs: number,
): Promise<Response> {
  const incomingUrl = new URL(c.req.raw.url);
  const encodedBase = `/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`;
  let suffix = inner ? `/${inner}` : '';
  if (trailingSlash) suffix = suffix ? `${suffix}/` : '/';
  // Never leak the router `?backend=` selector to the backend.
  const target = joinBackendUrlWithoutSelector(backend.base_url, `${encodedBase}${suffix}`, incomingUrl.search);
  // The caller's own `User-Agent` is forwarded here (the browser plane pins the
  // router's marker instead), which is why the shared forwarder takes headers
  // rather than building them.
  const headers = buildProxiedHeaders(c.req.raw, incomingUrl.origin, backend.base_url);
  const res = await forwardDavRequest(c.req.raw, target, headers, timeoutMs);
  return applyCors(res, c.req.raw);
}

// Volume-existence mutations change future probe outcomes, so the cached
// owner must go. Inner-file writes never change ownership → no invalidation.
function trackVolumeMutation(c: RouteContext, kv: KvCache | null, owner: string, volume: string, inner: string, status: number): void {
  if (status < 200 || status >= 300) return;
  const method = c.req.raw.method;
  if (inner === '' && ['MKCOL', 'DELETE', 'MOVE'].includes(method)) {
    // Unconditional: this request just proved it holds the route, so the entry
    // is almost certainly present. Unlike the `Destination` case below, a read
    // first would spend an operation to save one.
    runInBackground(c, invalidateCachedRoute(kv, owner, volume), 'route cache invalidate');
  }
  if (method === 'MOVE' || method === 'COPY') {
    try {
      const routerOrigin = new URL(c.req.raw.url).origin;
      const dest = parseDestinationVolume(routerOrigin, c.req.raw.headers.get('Destination'));
      if (dest && (dest.owner !== owner || dest.volume !== volume)) {
        // Read-before-delete: a cross-volume sync MOVEs into directories the
        // router never cached, and a delete spent on a missing key counts
        // against the same daily allowance as one spent on a present key.
        runInBackground(c, invalidateCachedRouteIfPresent(kv, dest.owner, dest.volume), 'route cache invalidate (destination)');
      }
    } catch {
      // A malformed `Destination` is the backend's to report; the router has no
      // opinion about where a file should land.
    }
  }
}

function registerRouterDavProxyRoutes(app: App): void {
  const methods = [...SUPPORT_METHODS] as never[];
  app.on(methods, '/:owner/:volume/*', async (c) =>
    handleProxy(c, c.req.param('owner') ?? '', c.req.param('volume') ?? '', innerPathOf(c.req.url), endsWithSlash(c.req.url)),
  );
  app.on(methods, '/:owner/:volume', async (c) => handleProxy(c, c.req.param('owner') ?? '', c.req.param('volume') ?? '', '', endsWithSlash(c.req.url)));

  // The DAV handlers above are registered per-method, so a WebDAV path reached
  // with any other method (`POST`, `PATCH`, `TRACE`, …) matched no route at all
  // and fell through to Hono's default 404. RFC 9110 requires 405 with `Allow`
  // when the resource exists but the method does not, and clients use the
  // distinction to tell "wrong verb" from "no such bucket".
  const methodNotAllowed = (c: { req: { raw: Request } }): Response =>
    applyCors(new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', ') } }), c.req.raw);
  app.all('/:owner/:volume', methodNotAllowed as never);
  app.all('/:owner/:volume/*', methodNotAllowed as never);
}

/**
 * The inner sub-path, derived from encoded segments so `%20` and unicode names
 * survive verbatim. `c.req.param` values are decoded and cannot be used for
 * prefix slicing — a name containing `/` would be re-split here.
 */
function innerPathOf(url: string): string {
  const segments = new URL(url).pathname.split('/');
  const rest = segments.length > 3 ? segments.slice(3).join('/') : '';
  return stripSlashes(rest);
}

function endsWithSlash(url: string): boolean {
  return new URL(url).pathname.endsWith('/');
}

export { registerRouterDavProxyRoutes };
