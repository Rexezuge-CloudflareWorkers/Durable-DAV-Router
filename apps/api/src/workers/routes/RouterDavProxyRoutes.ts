import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import {
  buildProxiedHeaders,
  fetchWithTimeout,
  filterProxiedResponseHeaders,
  getCachedRoute,
  getProxyTimeoutMs,
  invalidateCachedRoute,
  joinBackendUrlWithoutSelector,
  parseDestinationVolume,
  probeCandidateBackends,
  putCachedRoute,
  resolveBackend,
  stripSlashes,
} from '@durable-dav-router/backend-services/router';
import type { BackendService } from '@durable-dav-router/backend-services/router';
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';
import { SUPPORT_METHODS, applyCors } from '@durable-dav-router/webdav';
import { BaseRoute } from '@/endpoints/IBaseRoute';

type App = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;
type ProxyContext = { req: { raw: Request }; env: Env; executionCtx?: unknown };

function explicitBackendSlug(request: Request): string | null {
  try {
    const q = new URL(request.url).searchParams.get('backend');
    if (q?.trim()) return q.trim();
  } catch {
    // ignore malformed URL; header fallback below
  }
  const h = request.headers.get('X-Backend');
  return h?.trim() ? h.trim() : null;
}

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

function resolveKvCache(scope: { get: (token: never) => KvCache }): KvCache | null {
  try {
    return scope.get(Tokens.KvCache as never);
  } catch {
    return null;
  }
}

function serviceOf(scope: { get: (token: never) => BackendService }): BackendService {
  return scope.get(Tokens.BackendService as never);
}

function cachedBackendId(backend: { id?: unknown; slug: string }): string {
  return typeof backend.id === 'string' && backend.id.length > 0 ? backend.id : backend.slug;
}

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

async function handleProxy(c: ProxyContext, owner: string, volume: string, inner: string, trailingSlash: boolean): Promise<Response> {
  const method = c.req.raw.method;
  if (!SUPPORT_METHODS.includes(method)) {
    return applyCors(new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', ') } }), c.req.raw);
  }
  const scope = BaseRoute.getScope(c as never);
  const kv = resolveKvCache(scope);
  const explicit = explicitBackendSlug(c.req.raw);
  // KV lookaside: bare client URLs repeat the same owner/volume for every
  // operation of a sync run. A hit skips both the D1 owner lookup and the N
  // parallel volume-root probes. Trust + self-heal: a stale hit surfaces as a
  // forward 404/410, which evicts and re-resolves.
  if (!explicit) {
    const cached = await getCachedRoute(kv, owner, volume).catch(() => null);
    if (cached) {
      // Revalidate against D1 before spending a forward on it. A cache entry can
      // name a deleted backend or a `base_url` that has since been edited, and
      // the first symptom of that is a request already sent to the wrong
      // origin. Self-healing after the forward instead meant replaying the
      // request — with a body that had already been consumed.
      const current = await serviceOf(scope)
        .findBackendById(cached.backendId)
        .catch(() => null);
      if (current && current.base_url === cached.baseUrl) {
        const res = await proxyToBackend(c, current, owner, volume, inner, trailingSlash, getProxyTimeoutMs(c.env));
        if (!STALE_CACHED_STATUSES.has(res.status)) {
          trackVolumeMutation(c, kv, owner, volume, inner, res.status);
          return res;
        }
        await res.body?.cancel().catch(() => undefined);
        if (!REPLAY_SAFE_METHODS.has(method)) {
          // The origin is authoritative for this request; evict so the *next*
          // one re-resolves, but do not replay this request against a second
          // backend.
          runInBackground(c, invalidateCachedRoute(kv, owner, volume), 'route cache invalidate');
          return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
        }
        runInBackground(c, invalidateCachedRoute(kv, owner, volume), 'route cache invalidate');
      } else {
        runInBackground(c, invalidateCachedRoute(kv, owner, volume), 'route cache invalidate');
      }
    }
  }
  // WebDAV proxy is owner-routed, not requester-routed. Native clients only
  // send per-bucket Basic `Authorization` — they never carry Cloudflare Access
  // JWT — so requiring an Access identity here breaks every client (401).
  // Usernames are per-backend (same email may own different handles on
  // different backends); the router keeps only a `backend_username` cache per
  // registered backend and routes on it. The backend enforces
  // public-vs-private itself with the verbatim-proxied credentials.
  let backends: Array<{ slug: string; base_url: string }> = [];
  try {
    backends = await scope
      .get(Tokens.BackendService)
      .listByBackendUsername(owner)
      .catch(() => []);
  } catch {
    backends = [];
  }
  if (backends.length === 0) {
    return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
  }
  const resolved = resolveBackend(backends as never, explicit);
  if (resolved.kind === 'not-found') {
    return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
  }
  if (resolved.kind === 'ambiguous') {
    // Bare client URLs carry no `?backend=` hint. When the owner maps to
    // several backends, probe each candidate's volume root and route to the
    // unique owner instead of failing dumb clients with 409 (KV hit path
    // above already skipped this on warm routes). Creation of a brand-new
    // top-level volume (no backend has it) still needs an explicit selector
    // and stays 409.
    const incomingUrl = new URL(c.req.raw.url);
    const timeoutMs = getProxyTimeoutMs(c.env);
    const probed = await probeCandidateBackends({
      candidates: resolved.backends,
      volumePath: `/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`,
      incoming: c.req.raw,
      routerOrigin: incomingUrl.origin,
      timeoutMs,
    }).catch(() => ({ kind: 'unavailable' }) as const);
    if (probed.kind === 'single') {
      // Bare by construction (explicit never yields ambiguous) → cacheable.
      rememberRoute(c, kv, owner, volume, probed.backend);
      return proxyAndTrack(c, kv, probed.backend, owner, volume, inner, trailingSlash, timeoutMs);
    }
    if (probed.kind === 'not-found') {
      return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
    }
    if (probed.kind === 'unavailable') {
      return applyCors(new Response('Backend unreachable', { status: 502 }), c.req.raw);
    }
    // Genuine collision (same volume on several backends). Unauthenticated
    // WebDAV callers get no slug enumeration — they already know their slugs
    // from the authenticated dashboard (`/user/volumes`). Never cached.
    return applyCors(
      Response.json(
        {
          Exception: { Type: 'Conflict', Message: 'Multiple backends match; retry with ?backend=<slug>' },
        },
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
      c.req.raw,
    );
  }
  const backend = resolved.backend;
  // Lone-backend owners are cacheable, but explicit selections are not: with
  // a true collision an explicit choice must never become the bare default.
  if (!explicit) rememberRoute(c, kv, owner, volume, backend);
  return proxyAndTrack(c, kv, backend, owner, volume, inner, trailingSlash, getProxyTimeoutMs(c.env));
}

function rememberRoute(
  c: ProxyContext,
  kv: KvCache | null,
  owner: string,
  volume: string,
  backend: { id?: unknown; slug: string; base_url: string },
): void {
  runInBackground(
    c,
    putCachedRoute(kv, c.env, owner, volume, {
      backendId: cachedBackendId(backend),
      slug: backend.slug,
      baseUrl: backend.base_url,
    }),
    'route cache populate',
  );
}

async function proxyAndTrack(
  c: ProxyContext,
  kv: KvCache | null,
  backend: { base_url: string },
  owner: string,
  volume: string,
  inner: string,
  trailingSlash: boolean,
  timeoutMs: number,
): Promise<Response> {
  const res = await proxyToBackend(c, backend, owner, volume, inner, trailingSlash, timeoutMs);
  trackVolumeMutation(c, kv, owner, volume, inner, res.status);
  return res;
}

// Volume-existence mutations change future probe outcomes, so the cached
// owner must go. Inner-file writes never change ownership → no invalidation.
function trackVolumeMutation(c: ProxyContext, kv: KvCache | null, owner: string, volume: string, inner: string, status: number): void {
  if (status < 200 || status >= 300) return;
  const method = c.req.raw.method;
  if (inner === '' && ['MKCOL', 'DELETE', 'MOVE'].includes(method)) {
    runInBackground(c, invalidateCachedRoute(kv, owner, volume), 'route cache invalidate');
  }
  if (method === 'MOVE' || method === 'COPY') {
    try {
      const routerOrigin = new URL(c.req.raw.url).origin;
      const dest = parseDestinationVolume(routerOrigin, c.req.raw.headers.get('Destination'));
      if (dest && (dest.owner !== owner || dest.volume !== volume)) {
        runInBackground(c, invalidateCachedRoute(kv, dest.owner, dest.volume), 'route cache invalidate (destination)');
      }
    } catch {
      // ignore malformed URL; the proxied backend reports the real error
    }
  }
}

async function proxyToBackend(
  c: { req: { raw: Request }; env: Env },
  backend: { base_url: string },
  owner: string,
  volume: string,
  inner: string,
  trailingSlash: boolean,
  timeoutMs: number,
): Promise<Response> {
  const method = c.req.raw.method;
  const incomingUrl = new URL(c.req.raw.url);
  const encodedBase = `/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`;
  let suffix = inner ? `/${inner}` : '';
  if (trailingSlash) suffix = suffix ? `${suffix}/` : '/';
  // Never leak the router `?backend=` selector to the backend.
  const target = joinBackendUrlWithoutSelector(backend.base_url, `${encodedBase}${suffix}`, incomingUrl.search);
  const routerOrigin = incomingUrl.origin;
  const headers = buildProxiedHeaders(c.req.raw, routerOrigin, backend.base_url);
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      new Request(target),
      {
        method,
        headers,
        redirect: 'manual',
        body: hasBody ? c.req.raw.body : undefined,
        ...(hasBody && { duplex: 'half' }),
      },
      timeoutMs,
    );
  } catch (error) {
    // A timeout is a 504, not a 502: the origin did not answer within the
    // budget, which is a distinct condition clients retry differently. Log the
    // cause — a silent catch here is the only signal an unreachable backend
    // produces.
    const isTimeout = error instanceof Error && (error.name === 'AbortError' || /aborted|timeout/i.test(error.message));
    console.warn(
      `backend ${backend.base_url} ${isTimeout ? `timed out after ${timeoutMs}ms` : 'unreachable'} for ${method} ${encodedBase}${suffix}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const message = isTimeout ? 'Backend timed out' : 'Backend unreachable';
    return applyCors(new Response(message, { status: isTimeout ? 504 : 502 }), c.req.raw);
  }
  const outHeaders = filterProxiedResponseHeaders(upstream.headers);
  return applyCors(new Response(upstream.body, { status: upstream.status, headers: outHeaders }), c.req.raw);
}

function registerRouterDavProxyRoutes(app: App): void {
  const methods = [...SUPPORT_METHODS] as never[];
  app.on(methods, '/:owner/:volume/*', async (c) => {
    const owner = c.req.param('owner') ?? '';
    const volume = c.req.param('volume') ?? '';
    const url = new URL(c.req.url);
    // Derive the inner sub-path from encoded segments so `%20`/unicode names
    // survive verbatim; `c.req.param` values are decoded and can't be used
    // for prefix slicing.
    const segments = url.pathname.split('/');
    const rest = segments.length > 3 ? segments.slice(3).join('/') : '';
    const inner = stripSlashes(rest);
    const trailingSlash = url.pathname.endsWith('/');
    return handleProxy(c, owner, volume, inner, trailingSlash);
  });
  app.on(methods, '/:owner/:volume', async (c) => {
    const owner = c.req.param('owner') ?? '';
    const volume = c.req.param('volume') ?? '';
    const trailingSlash = new URL(c.req.url).pathname.endsWith('/');
    return handleProxy(c, owner, volume, '', trailingSlash);
  });

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

export { registerRouterDavProxyRoutes };
