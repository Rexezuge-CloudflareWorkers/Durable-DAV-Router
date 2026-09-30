import type { Hono } from 'hono';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';
import {
  describeBackendFailure,
  fetchWithTimeout,
  forwardAuthHeaders,
  getProxyTimeoutMs,
  isTimeoutError,
  joinBackendUrl,
  markAsRouterRequest,
  stripTrailingSlashes,
  truncateSnippet,
} from '@durable-dav-router/backend-services/router';
import { BaseRoute, handleRoute } from '@/endpoints/IBaseRoute';
import { resolveBackendService } from './scopeAccess';
import type { AuthenticatedAccount, RouteContext, RouterEnv } from '@/requestContext';

type App = Hono<RouterEnv>;

/**
 * A `router_backends` row as the API reports it.
 *
 * `base_url` → `baseUrl` and the rest: the row is snake_case because it is a
 * database row, and this is the one place that translation happens, so no client
 * ever has to know the column names.
 */
function toBackendJson(r: {
  slug: string;
  base_url: string;
  display_name: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  last_status: number | null;
  backend_username?: string | null;
}) {
  return {
    slug: r.slug,
    baseUrl: r.base_url,
    displayName: r.display_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
    lastStatus: r.last_status,
    backendUsername: r.backend_username ?? null,
  };
}

type BackendJson = ReturnType<typeof toBackendJson>;

/**
 * Ask a backend for its liveness and return its status, or `null` if it could
 * not be asked at all.
 *
 * The body is released without being read. Only the status matters here, and an
 * unread body keeps the connection — and the isolate's memory — held until the
 * runtime garbage-collects it. Buffering instead would be an unbounded read of a
 * body this path discards, since the timeout only covers the response headers.
 */
async function probeBackendHealth(baseUrl: string, timeoutMs: number, auth?: Headers): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      new Request(`${stripTrailingSlashes(baseUrl)}/health`),
      { method: 'GET', headers: new Headers(auth), redirect: 'manual' },
      timeoutMs,
    );
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Probe a backend's liveness, record it, and read the row back.
 *
 * Identical after a create and after an edit; it was written out twice with only
 * the variable name differing. The probe never blocks: a backend that will not
 * answer is still registered, because refusing to save it would leave the user
 * with no way to see or fix the problem from the UI that caused it.
 *
 * The re-read is what makes the response carry the probe — `recordProbe` writes
 * `last_status`/`last_seen_at`, and returning the pre-probe row would show a
 * health badge of `null` until the next page load. A failed re-read falls back to
 * the row already in hand, which is the correct answer.
 */
async function probeAndRefresh(
  c: RouteContext,
  owner: AuthenticatedAccount,
  known: RouterBackendRow,
): Promise<RouterBackendRow> {
  const service = resolveBackendService(BaseRoute.getScope(c));
  const status = await probeBackendHealth(known.base_url, getProxyTimeoutMs(c.env), markAsRouterRequest(forwardAuthHeaders(c.req.raw)));
  await service.recordProbe(owner, known.slug, status);
  return await service.getBackend(owner, known.slug).catch(() => known);
}

/**
 * Shape of `POST /user/backends`, after validation.
 */
interface CreateBackendBody {
  slug?: unknown;
  baseUrl?: unknown;
  displayName?: unknown;
}

/**
 * Read and validate a `POST /user/backends` body.
 *
 * Without this, a non-string `slug` reached `normalizeSlug` and threw
 * `TypeError: raw.trim is not a function`, which surfaced as a 500 rather than
 * the 400 it is. `readJson` also enforces the 1 MiB cap that the raw
 * `c.req.json()` cast bypassed entirely.
 */
async function readCreateBody(c: RouteContext): Promise<{ body: CreateBackendBody } | { error: Response }> {
  const parsed = await BaseRoute.readJson<CreateBackendBody>(c);
  if (parsed.oversized) return { error: BaseRoute.jsonError(c, 'Request body too large', 413) };
  if (parsed.malformed) return { error: BaseRoute.jsonError(c, 'Malformed JSON body', 400) };
  const body = parsed.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { error: BaseRoute.jsonError(c, 'Body must be a JSON object', 400) };
  }
  if (typeof body.slug !== 'string' || body.slug.trim().length === 0) {
    return { error: BaseRoute.jsonError(c, 'slug is required', 400) };
  }
  if (typeof body.baseUrl !== 'string' || body.baseUrl.trim().length === 0) {
    return { error: BaseRoute.jsonError(c, 'baseUrl is required', 400) };
  }
  return body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string'
    ? { error: BaseRoute.jsonError(c, 'displayName must be a string or null', 400) }
    : { body };
}

/**
 * Read and validate a `PATCH /user/backends/:slug` body.
 *
 * Both fields are optional and neither may be the wrong type. An absent field is
 * left absent rather than defaulted, so a patch that names only `displayName`
 * does not also blank `baseUrl`.
 */
async function readPatchBody(
  c: RouteContext,
): Promise<{ patch: { baseUrl?: string; displayName?: string | null } } | { error: Response }> {
  const parsed = await BaseRoute.readJson<{ baseUrl?: unknown; displayName?: unknown }>(c);
  if (parsed.oversized) return { error: BaseRoute.jsonError(c, 'Request body too large', 413) };
  if (parsed.malformed) return { error: BaseRoute.jsonError(c, 'Malformed JSON body', 400) };
  const body = parsed.body ?? {};
  if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
    return { error: BaseRoute.jsonError(c, 'baseUrl must be a string', 400) };
  }
  if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') {
    return { error: BaseRoute.jsonError(c, 'displayName must be a string or null', 400) };
  }
  const patch: { baseUrl?: string; displayName?: string | null } = {};
  if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
  if (body.displayName !== undefined) patch.displayName = body.displayName;
  return { patch };
}

const listBackends = handleRoute(async (c: RouteContext): Promise<Response> => {
  const rows = await resolveBackendService(BaseRoute.getScope(c)).listBackends(c.get('AuthenticatedAccount'));
  return c.json({ backends: rows.map(toBackendJson) });
});

const createBackend = handleRoute(async (c: RouteContext): Promise<Response> => {
  const parsed = await readCreateBody(c);
  if ('error' in parsed) return parsed.error;
  const owner = c.get('AuthenticatedAccount');
  const created = await resolveBackendService(BaseRoute.getScope(c)).createBackend({
    owner,
    slug: parsed.body.slug as string,
    baseUrl: parsed.body.baseUrl as string,
    displayName: (parsed.body.displayName as string | null | undefined) ?? null,
  });
  return c.json(toBackendJson(await probeAndRefresh(c, owner, created)), 201);
});

const getBackend = handleRoute(async (c: RouteContext): Promise<Response> => {
  const row = await resolveBackendService(BaseRoute.getScope(c)).getBackend(c.get('AuthenticatedAccount'), c.req.param('slug') ?? '');
  return c.json(toBackendJson(row));
});

const updateBackend = handleRoute(async (c: RouteContext): Promise<Response> => {
  const parsed = await readPatchBody(c);
  if ('error' in parsed) return parsed.error;
  const owner = c.get('AuthenticatedAccount');
  const service = resolveBackendService(BaseRoute.getScope(c));
  const updated = await service.updateBackend(owner, c.req.param('slug') ?? '', parsed.patch);
  // No route-cache purge: the `davRoute` lookaside revalidates every entry against
  // D1 before it forwards (`findBackendById`, then a `base_url` comparison), so an
  // edited `base_url` is caught on the very next request and re-resolved without
  // spending a forward. Purging instead cost one delete per cached route in the
  // whole namespace — every user's, not this backend's — on a single
  // settings-page save, against an allowance of 1,000 deletes per day.
  return c.json(toBackendJson(await probeAndRefresh(c, owner, updated)));
});

const deleteBackend = handleRoute(async (c: RouteContext): Promise<Response> => {
  await resolveBackendService(BaseRoute.getScope(c)).deleteBackend(c.get('AuthenticatedAccount'), c.req.param('slug') ?? '');
  // Likewise no purge: a cached route naming the removed backend fails its D1
  // revalidation (`findBackendById` returns null) and is re-resolved on the next
  // bare request, which is the same path an edit takes.
  return c.json({ ok: true });
});

/**
 * Per-backend identity: the username the authenticated account owns on this
 * backend. Usernames are per-backend, never global.
 *
 * Proxies verbatim to backend `GET /user/me` with the caller's passthrough auth
 * and caches the result in `router_backends.backend_username`, which is what
 * unauthenticated WebDAV owner routing reads. The caller's `Accept` is forced to
 * JSON so a backend that content-negotiates answers with the identity object
 * rather than an HTML shell.
 */
const getBackendIdentity = handleRoute(async (c: RouteContext): Promise<Response> => {
  const owner = c.get('AuthenticatedAccount');
  const scope = BaseRoute.getScope(c);
  const service = resolveBackendService(scope);
  const slug = c.req.param('slug') ?? '';
  const row = await service.getBackend(owner, slug);
  const res = await fetchWithTimeout(
    new Request(joinBackendUrl(row.base_url, '/user/me')),
    { method: 'GET', headers: markAsRouterRequest(forwardAuthHeaders(c.req.raw)), redirect: 'manual' },
    getProxyTimeoutMs(c.env),
  );
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return new Response(text || JSON.stringify({ Exception: { Type: 'BadGateway', Message: 'Backend identity lookup failed' } }), {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    });
  }
  const username = usernameOfIdentity(text);
  await service.recordBackendUsername(owner, row.slug, username);
  return c.json({ slug: row.slug, username });
});

/**
 * The username a backend's `/user/me` reported, or `null`.
 *
 * A non-JSON body is a `null`, not a throw: a backend that answers the identity
 * lookup with an error page still has a correct answer for *routing*, which is
 * "no handle cached yet" — and the caller's own request has already succeeded.
 */
function usernameOfIdentity(body: string): string | null {
  try {
    const data = JSON.parse(body) as { username?: unknown };
    return typeof data.username === 'string' && data.username.trim() ? data.username.trim() : null;
  } catch {
    return null;
  }
}

/**
One origin probe, reported the way an operator needs to read it.
*/
interface OriginProbe {
  status: number | null;
  error: string | null;
}

/**
 * Live diagnostic: what the router sees when it fetches this backend.
 *
 * Hits `<baseUrl>/health` + `<baseUrl>/user/volumes` from Worker egress (same
 * path as the Dashboard fan-out) so a `522 works-from-browser` case can be
 * distinguished: browser-ok + router-522 means the origin and its Access/firewall
 * configuration allows browsers but not Worker fetches, which is the single most
 * common way a self-hosted Durable-DAV fails only through this router.
 */
const probeBackend = handleRoute(async (c: RouteContext): Promise<Response> => {
  const owner = c.get('AuthenticatedAccount');
  const row = await resolveBackendService(BaseRoute.getScope(c)).getBackend(owner, c.req.param('slug') ?? '');
  const timeoutMs = getProxyTimeoutMs(c.env);
  const auth = markAsRouterRequest(forwardAuthHeaders(c.req.raw));

  const check = async (path: string): Promise<OriginProbe> => {
    try {
      const res = await fetchWithTimeout(new Request(joinBackendUrl(row.base_url, path)), { method: 'GET', headers: auth, redirect: 'manual' }, timeoutMs);
      if (res.ok) return { status: res.status, error: null };
      const snippet = truncateSnippet(await res.text().catch(() => ''), 200);
      return { status: res.status, error: describeBackendFailure(res.status, snippet) };
    } catch (error) {
      return isTimeoutError(error) ? { status: 504, error: `backend probe timed out after ${timeoutMs}ms (backend slow or unreachable from Worker egress)` } : { status: null, error: 'backend probe failed: Worker egress could not reach baseUrl (DNS/TLS/firewall?)' };
    }
  };

  const [health, volumes] = await Promise.all([check('/health'), check('/user/volumes')]);
  await resolveBackendService(BaseRoute.getScope(c))
    .recordProbe(owner, row.slug, health.status)
    .catch(() => undefined);
  return c.json({ slug: row.slug, baseUrl: row.base_url, health, volumes });
});

function registerBackendRoutes(app: App): void {
  app.get('/user/backends', async (c) => listBackends(c));
  app.post('/user/backends', async (c) => createBackend(c));
  app.get('/user/backends/:slug', async (c) => getBackend(c));
  app.patch('/user/backends/:slug', async (c) => updateBackend(c));
  app.delete('/user/backends/:slug', async (c) => deleteBackend(c));
  app.get('/user/backends/:slug/me', async (c) => getBackendIdentity(c));
  app.get('/user/backends/:slug/probe', async (c) => probeBackend(c));
}

export { registerBackendRoutes };
export type { BackendJson };
