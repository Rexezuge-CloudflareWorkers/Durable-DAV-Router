import type { Hono } from 'hono';
import {
  bodylessMethods,
  buildProxiedHeaders,
  describeBackendFailure,
  explicitBackendSlug,
  fetchWithTimeout,
  forwardAuthHeaders,
  forwardDavRequest,
  getProxyTimeoutMs,
  invalidateCachedRoute,
  isTimeoutError,
  joinBackendUrl,
  joinBackendUrlWithoutSelector,
  markAsRouterRequest,
  ROUTER_USER_AGENT,
  selectBackend,
  truncateSnippet,
} from '@durable-dav-router/backend-services/router';
import { NotFoundError } from '@durable-dav-router/backend-errors';
import { SUPPORT_METHODS } from '@durable-dav-router/webdav';
import { BaseRoute, handleRoute } from '@/endpoints/IBaseRoute';
import { resolveBackendService, resolveKvCache } from './scopeAccess';
import type { AuthenticatedAccount, RouteContext, RouterEnv } from '@/requestContext';

type App = Hono<RouterEnv>;

/**
 * Non-DAV verbs this plane accepts in addition to `SUPPORT_METHODS`.
 *
 * `/credentials/*` under the browser plane is JSON management, not RFC 4918, so
 * these two belong to this route only. Kept as a named delta rather than folded
 * into the DAV list, which is what made the old hand-written list read as 14
 * DAV verbs when it was 12 plus 2.
 */
const BROWSER_PLANE_EXTRA_METHODS = ['POST', 'PATCH'];

/**
Methods that never carry a request body.

The DAV plane's rule rather than a second copy of it: this file's `['GET','HEAD']`
omitted `OPTIONS` while `forwardDavRequest` included it, so the two planes had
already disagreed about one question. Two implementations of one rule is how
that happens, and nothing about it is visible in a status code.
*/
const BODYLESS_METHODS = bodylessMethods();

/**
 * Forward a management request to a backend and pass the response through.
 *
 * The router adds no interpretation here: the backend owns volume semantics, so
 * its status, body, and content type are returned verbatim. A transport failure
 * becomes a 502 rather than an exception, because "the backend is unreachable"
 * is a real answer for a proxy.
 */
async function forwardToBackend(request: Request, target: string, env: Env, body: ReadableStream | string | null): Promise<Response> {
  const headers = markAsRouterRequest(forwardAuthHeaders(request));
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);
  const method = request.method;
  const hasBody = !BODYLESS_METHODS.has(method);
  let res: Response;
  try {
    res = await fetchWithTimeout(
      new Request(target),
      {
        method,
        headers,
        redirect: 'manual',
        body: hasBody ? body : undefined,
        // A stream body needs an explicit half-duplex signal; a string body
        // does not, and passing it would be rejected.
        ...(!(hasBody && typeof body === 'string') && { duplex: 'half' }),
      },
      getProxyTimeoutMs(env),
    );
  } catch (error) {
    const isTimeout = isTimeoutError(error);
    console.warn(
      `backend ${new URL(target).origin} ${isTimeout ? 'timed out' : 'unreachable'} for ${method}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Response(isTimeout ? 'Backend timed out' : 'Backend unreachable', { status: isTimeout ? 504 : 502 });
  }
  const text = await res.text().catch(() => '');
  return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
}

/**
 * The caller's account.
 *
 * Throws rather than returning a fallback: `/user/*` is behind
 * `userAuthentication`, so a missing account here is a wiring error, and the
 * alternative — an empty backend list — would render as "you have no backends"
 * on a page whose owner does have several.
 */
function authenticatedAccount(c: RouteContext): AuthenticatedAccount {
  const account = c.get('AuthenticatedAccount');
  if (!account) throw new NotFoundError('Not authenticated');
  return account;
}

// Single-bucket management proxies verbatim to the owning backend.
// `?backend=` (or `X-Backend`) disambiguates when several backends exist;
// a lone backend is used implicitly, multiple without selector → 409.
const proxyOne = handleRoute(async (c: RouteContext): Promise<Response> => {
  const account = authenticatedAccount(c);
  // Named `volumeOwner`, not `owner`: this is the *per-backend* username segment
  // of the path, which is a different namespace from the router account. The two
  // collided once the account arrived as an object, and the WebDAV owner-routing
  // key is the one thing that must not be confused with an identity.
  const volumeOwner = c.req.param('owner') ?? '';
  const volume = c.req.param('volume') ?? '';
  const service = resolveBackendService(BaseRoute.getScope(c));
  const backend = selectBackend(await service.listBackends(account), explicitBackendSlug(c));
  const res = await forwardToBackend(
    c.req.raw,
    joinBackendUrlWithoutSelector(
      backend.base_url,
      `/user/volumes/${encodeURIComponent(volumeOwner)}/${encodeURIComponent(volume)}`,
      new URL(c.req.raw.url).search,
    ),
    c.env,
    c.req.raw.body,
  );
  // Volume deletion changes future probe outcomes → evict the cached owner.
  if (c.req.raw.method === 'DELETE' && res.ok) {
    await invalidateCachedRoute(resolveKvCache(BaseRoute.getScope(c)), volumeOwner, volume);
  }
  return res;
});

/**
 * Forward a browser-plane request (`/user/volumes/:owner/:volume/files/*`) to a
 * backend as the DAV client it is, and stream the answer back untouched.
 *
 * The bucket browser is a WebDAV client, so this plane cannot use the JSON
 * management forwarder above. Three headers carry meaning here and none of them
 * is `Accept`: `Depth` (RFC 4918 §9.1 makes an absent one `infinity`, so a
 * folder listing arrives holding the whole subtree), `Destination` (rewritten
 * onto the backend origin, since the SPA builds it from the router's own and the
 * backend answers `502` for a cross-origin one), and `Overwrite`. The body is
 * file bytes, so it is streamed rather than read — `res.text()` decodes them as
 * UTF-8 and corrupts every binary download.
 *
 * `apps/api/AGENTS.md` records the three separate user-visible failures this
 * split fixed; `test/api-routes.test.ts` → *browser-plane subpath proxy* asserts
 * each header and a byte-exact body, because a status-code assertion passes on a
 * request whose meaning was stripped.
 */
async function forwardDavToBackend(request: Request, target: string, env: Env, backendBaseUrl: string): Promise<Response> {
  const headers = buildProxiedHeaders(request, new URL(request.url).origin, backendBaseUrl);
  // The one header the two planes deliberately disagree on, set individually
  // rather than through `markAsRouterRequest`: the WebDAV plane forwards the
  // caller's own `User-Agent`, while this plane pins the router's marker because
  // a backend may already branch on it. `Accept` must *not* be pinned — this is a
  // DAV request, and telling the backend to answer in JSON is how a PROPFIND
  // starts returning a `207` the client cannot parse. `forwardDavRequest` takes
  // headers rather than building them precisely so the two planes can differ
  // here without duplicating the fetch.
  headers.set('User-Agent', ROUTER_USER_AGENT);
  return forwardDavRequest(request, target, headers, getProxyTimeoutMs(env));
}

// Browser-plane + credential subpaths (`/files/*`, `/credentials/*`, …) proxy
// verbatim to the owning backend so the uniform WebUI manages each backend
// through one shape. `/files/*` is a DAV client and goes through the DAV
// forwarder; the credential subpaths ride the same faithful path, which costs
// them nothing (a JSON body is just another body) and keeps the two planes from
// disagreeing about which headers carry meaning.
const proxySubpath = handleRoute(async (c: RouteContext): Promise<Response> => {
  const account = authenticatedAccount(c);
  const service = resolveBackendService(BaseRoute.getScope(c));
  const backend = selectBackend(await service.listBackends(account), explicitBackendSlug(c));
  const incomingUrl = new URL(c.req.raw.url);
  // The full path is preserved so the backend sees the same resource shape the
  // caller asked for; only the router's own selector is stripped.
  return forwardDavToBackend(
    c.req.raw,
    joinBackendUrlWithoutSelector(backend.base_url, incomingUrl.pathname, incomingUrl.search),
    c.env,
    backend.base_url,
  );
});

/**
Create a bucket on the selected backend (`?backend=` disambiguates).
*/
const createVolume = handleRoute(async (c: RouteContext): Promise<Response> => {
  const account = authenticatedAccount(c);
  const service = resolveBackendService(BaseRoute.getScope(c));
  const backend = selectBackend(await service.listBackends(account), explicitBackendSlug(c));
  const body = await c.req.json().catch(() => ({}));
  // Re-serialize the parsed body rather than streaming `c.req.raw.body`, so the
  // request is replayable and `Content-Length` is unambiguous. Volume creation
  // payloads are small.
  const res = await forwardToBackend(c.req.raw, joinBackendUrl(backend.base_url, '/user/volumes'), c.env, JSON.stringify(body));
  const text = await res.text().catch(() => '');
  if (res.ok) {
    // The created volume's owner is the WebDAV routing key, so cache it. A parse
    // or write failure must not fail a creation that already succeeded at the
    // backend — the two are not reversible, and the routing key re-probes.
    const owner = ownerOfCreatedVolume(text);
    if (owner) await service.recordBackendUsername(account, backend.slug, owner);
  }
  return jsonPassthrough(res, text);
});

/**
The `owner` a creation response names, if it names one.
*/
function ownerOfCreatedVolume(text: string): string | null {
  try {
    const created = JSON.parse(text) as { owner?: unknown };
    return typeof created.owner === 'string' && created.owner.trim() ? created.owner.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Relay a backend's JSON answer with its status and content type, unreshaped.
 *
 * The router adds no interpretation: the backend owns volume semantics, so its
 * status, body and content type are returned verbatim.
 */
function jsonPassthrough(upstream: Response, text: string): Response {
  return new Response(text, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' } });
}

interface BackendStatus {
  slug: string;
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Fan out to every registered backend and aggregate what came back.
 *
 * Fail-soft per backend by design: one Durable-DAV instance being down is the
 * normal state of a self-hosted deployment, and the dashboard must still show the
 * buckets that are reachable. A per-backend failure becomes an entry in
 * `backends[]` with the upstream status, not an error response — so the client
 * can tell "this backend refused me" from "the router could not reach it".
 */
const listVolumes = handleRoute(async (c: RouteContext): Promise<Response> => {
  const account = authenticatedAccount(c);
  const onlySlug = explicitBackendSlug(c);
  const service = resolveBackendService(BaseRoute.getScope(c));
  const all = await service.listBackends(account);
  const backends = onlySlug ? all.filter((b) => b.slug.toLowerCase() === onlySlug.toLowerCase()) : all;
  if (backends.length === 0) return c.json({ volumes: [], backends: [] });

  const timeoutMs = getProxyTimeoutMs(c.env);
  const settled = await Promise.allSettled(
    backends.map(async (b) => {
      const res = await fetchWithTimeout(
        new Request(joinBackendUrl(b.base_url, '/user/volumes')),
        { method: 'GET', headers: markAsRouterRequest(forwardAuthHeaders(c.req.raw)), redirect: 'manual' },
        timeoutMs,
      );
      if (!res.ok) {
        const snippet = truncateSnippet(await res.text().catch(() => ''), 200);
        // The upstream status rides along on the error so the aggregator can
        // report it verbatim rather than flattening every refusal to a 502.
        throw Object.assign(new Error(`backend ${b.slug} ${describeBackendFailure(res.status, snippet)}`), {
          backendSlug: b.slug,
          backendStatus: res.status,
        });
      }
      const data = (await res.json().catch(() => ({}))) as { volumes?: Array<Record<string, unknown>> };
      return { slug: b.slug, volumes: (data.volumes ?? []).map((v) => ({ ...v, backend: b.slug, backendBaseUrl: b.base_url })) };
    }),
  );

  const volumes: Array<Record<string, unknown>> = [];
  const status: BackendStatus[] = settled.map((result, i) => {
    const slug = backends[i].slug;
    if (result.status === 'fulfilled') {
      volumes.push(...result.value.volumes);
      return { slug, ok: true, status: 200 };
    }
    const reason = result.reason as Error & { backendStatus?: number };
    const upstreamStatus = typeof reason?.backendStatus === 'number' ? reason.backendStatus : null;
    const fallback = isTimeoutError(reason) ? 504 : 502;
    const code = upstreamStatus ?? fallback;
    const message = reason instanceof Error ? reason.message : 'backend unreachable';
    console.warn('backend fan-out failed', { slug, status: code, error: message.slice(0, 300) });
    return { slug, ok: false, status: code, error: message };
  });
  return c.json({ volumes, backends: status });
});

function registerAggregatedVolumeRoutes(app: App): void {
  app.post('/user/volumes', async (c) => createVolume(c));
  // Aggregated bucket list across all registered backends (fail-soft per backend).
  app.get('/user/volumes', async (c) => listVolumes(c));

  app.get('/user/volumes/:owner/:volume', async (c) => proxyOne(c));
  app.patch('/user/volumes/:owner/:volume', async (c) => proxyOne(c));
  app.delete('/user/volumes/:owner/:volume', async (c) => proxyOne(c));

  // Derived from `SUPPORT_METHODS` rather than restated. The hand-written list
  // this replaced had already drifted from the shared constant — `POST` and
  // `PATCH` had been added by hand, in a different order — and the only symptom
  // of that class of drift is a verb falling through to a 404, which is exactly
  // what a genuinely missing path returns too.
  //
  // `POST`/`PATCH` are the browser plane's own addition: the `/credentials/*`
  // subpaths this wildcard also carries are JSON management calls, not DAV
  // verbs, so they are added explicitly and visibly rather than folded into the
  // DAV list where they would look like RFC 4918 members.
  app.on(
    [...SUPPORT_METHODS, ...BROWSER_PLANE_EXTRA_METHODS] as never[],
    '/user/volumes/:owner/:volume/*',
    async (c) => proxySubpath(c),
  );
}

export { registerAggregatedVolumeRoutes };
