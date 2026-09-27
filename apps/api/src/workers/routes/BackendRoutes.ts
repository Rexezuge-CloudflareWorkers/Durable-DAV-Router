import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import {
  describeBackendFailure,
  fetchWithTimeout,
  getProxyTimeoutMs,
  joinBackendUrl,
  stripTrailingSlashes,
  truncateSnippet,
} from '@durable-dav-router/backend-services/router';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { HonoContext } from '@/endpoints/IBaseRoute';

type App = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

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

async function probeBackendHealth(baseUrl: string, timeoutMs: number, auth?: Headers): Promise<number | null> {
  try {
    const headers = new Headers(auth);
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', 'durable-dav-router');
    const res = await fetchWithTimeout(
      new Request(`${stripTrailingSlashes(baseUrl)}/health`),
      { method: 'GET', headers, redirect: 'manual' },
      timeoutMs,
    );
    // Release the subrequest. Only the status matters here, and an unread body
    // keeps the connection (and the isolate's memory) held until it is
    // garbage-collected. Buffering instead would be an unbounded read of a body
    // this path discards, since the timeout only covers the response headers.
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Forward the caller's Cloudflare Access credentials to a backend.
 *
 * Verbatim, because the router stores no credentials of its own: the backend
 * validates the assertion against its own Access application. `Accept` and
 * `User-Agent` are set by the caller when it wants them, so a probe and an
 * identity lookup can be told apart in backend logs.
 */
function incomingAuthHeaders(request: Request): Headers {
  const out = new Headers();
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ?? request.headers.get('cf-access-jwt-assertion');
  if (jwt) out.set('Cf-Access-Jwt-Assertion', jwt);
  const auth = request.headers.get('Authorization');
  if (auth) out.set('Authorization', auth);
  const cookie = request.headers.get('Cookie');
  if (cookie) out.set('Cookie', cookie);
  return out;
}

/**
Mark a request as a router-originated API call in backend logs.
*/
function markAsRouterRequest(headers: Headers): Headers {
  headers.set('Accept', 'application/json');
  headers.set('User-Agent', 'durable-dav-router');
  return headers;
}

/**
Shape of `POST /user/backends`, after validation.
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
async function readCreateBody(c: HonoContext): Promise<{ body: CreateBackendBody } | { error: Response }> {
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

function registerBackendRoutes(app: App): void {
  app.get('/user/backends', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const rows = await scope.get(Tokens.BackendService).listBackends(email);
      return c.json({ backends: rows.map(toBackendJson) });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  app.post('/user/backends', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    const parsed = await readCreateBody(c);
    if ('error' in parsed) return parsed.error;
    try {
      const created = await scope.get(Tokens.BackendService).createBackend({
        ownerEmail: email,
        slug: parsed.body.slug as string,
        baseUrl: parsed.body.baseUrl as string,
        displayName: (parsed.body.displayName as string | null | undefined) ?? null,
      });
      // Best-effort liveness probe; never blocks creation.
      const timeoutMs = getProxyTimeoutMs(c.env);
      const status = await probeBackendHealth(created.base_url, timeoutMs, incomingAuthHeaders(c.req.raw));
      await scope.get(Tokens.BackendService).recordProbe(email, created.slug, status);
      const refreshed = await scope
        .get(Tokens.BackendService)
        .getBackend(email, created.slug)
        .catch(() => created);
      return c.json(toBackendJson(refreshed), 201);
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  app.get('/user/backends/:slug', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const row = await scope.get(Tokens.BackendService).getBackend(email, c.req.param('slug') ?? '');
      return c.json(toBackendJson(row));
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  app.patch('/user/backends/:slug', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    const parsed = await BaseRoute.readJson<{ baseUrl?: unknown; displayName?: unknown }>(c);
    if (parsed.oversized) return BaseRoute.jsonError(c, 'Request body too large', 413);
    if (parsed.malformed) return BaseRoute.jsonError(c, 'Malformed JSON body', 400);
    const body = parsed.body ?? {};
    if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
      return BaseRoute.jsonError(c, 'baseUrl must be a string', 400);
    }
    if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') {
      return BaseRoute.jsonError(c, 'displayName must be a string or null', 400);
    }
    try {
      const updated = await scope.get(Tokens.BackendService).updateBackend(email, c.req.param('slug') ?? '', {
        ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl }),
        ...(body.displayName !== undefined && { displayName: body.displayName }),
      });
      // No route-cache purge: the `davRoute` lookaside revalidates every entry
      // against D1 before it forwards (`findBackendById`, then a `base_url`
      // comparison), so an edited `base_url` is caught on the very next request
      // and re-resolved without spending a forward. Purging instead cost one
      // delete per cached route in the whole namespace — every user's, not this
      // backend's — on a single settings-page save, against an allowance of
      // 1,000 deletes per day.
      const timeoutMs = getProxyTimeoutMs(c.env);
      const status = await probeBackendHealth(updated.base_url, timeoutMs, incomingAuthHeaders(c.req.raw));
      await scope.get(Tokens.BackendService).recordProbe(email, updated.slug, status);
      const refreshed = await scope
        .get(Tokens.BackendService)
        .getBackend(email, updated.slug)
        .catch(() => updated);
      return c.json(toBackendJson(refreshed));
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  app.delete('/user/backends/:slug', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await scope.get(Tokens.BackendService).deleteBackend(email, c.req.param('slug') ?? '');
      // Likewise no purge: a cached route naming the removed backend fails its
      // D1 revalidation (`findBackendById` returns null) and is re-resolved on
      // the next bare request, which is the same path an edit takes.
      return c.json({ ok: true });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  // Per-backend identity: the username the authenticated email owns on this
  // backend (usernames are per-backend, never global). Proxies verbatim to
  // backend `GET /user/me` with passthrough auth and caches the result in
  // `router_backends.backend_username` for WebDAV owner routing.
  app.get('/user/backends/:slug/me', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const row = await scope.get(Tokens.BackendService).getBackend(email, c.req.param('slug') ?? '');
      const timeoutMs = getProxyTimeoutMs(c.env);
      const auth = markAsRouterRequest(incomingAuthHeaders(c.req.raw));
      const res = await fetchWithTimeout(
        new Request(joinBackendUrl(row.base_url, '/user/me')),
        { method: 'GET', headers: auth, redirect: 'manual' },
        timeoutMs,
      );
      const text = await res.text().catch(() => '');
      let username: string | null = null;
      try {
        const data = JSON.parse(text) as { username?: unknown };
        username = typeof data.username === 'string' && data.username.trim() ? data.username.trim() : null;
      } catch {
        username = null;
      }
      if (!res.ok) {
        return new Response(text || JSON.stringify({ Exception: { Type: 'BadGateway', Message: 'Backend identity lookup failed' } }), {
          status: res.status,
          headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
        });
      }
      await scope
        .get(Tokens.BackendService)
        .recordBackendUsername(email, row.slug, username)
        .catch(() => undefined);
      return c.json({ slug: row.slug, username });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  // Live diagnostic: what the router sees when it fetches this backend.
  // Hits `<baseUrl>/health` + `<baseUrl>/user/volumes` from Worker egress
  // (same path as the Dashboard fan-out) so a `522 works-from-browser`
  // case can be distinguished: browser-ok + router-522 = origin/Access
  // allows browsers but not Worker fetches.
  app.get('/user/backends/:slug/probe', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const row = await scope.get(Tokens.BackendService).getBackend(email, c.req.param('slug') ?? '');
      const timeoutMs = getProxyTimeoutMs(c.env);
      const auth = markAsRouterRequest(incomingAuthHeaders(c.req.raw));

      async function check(path: string): Promise<{ status: number | null; error: string | null }> {
        try {
          const res = await fetchWithTimeout(
            new Request(joinBackendUrl(row.base_url, path)),
            { method: 'GET', headers: auth, redirect: 'manual' },
            timeoutMs,
          );
          if (res.ok) return { status: res.status, error: null };
          const snippet = truncateSnippet(await res.text().catch(() => ''), 200);
          return { status: res.status, error: describeBackendFailure(res.status, snippet) };
        } catch (error) {
          const isTimeout = error instanceof Error && (error.name === 'AbortError' || /aborted|timeout/i.test(error.message));
          return {
            status: isTimeout ? 504 : null,
            error: isTimeout
              ? `backend probe timed out after ${timeoutMs}ms (backend slow or unreachable from Worker egress)`
              : 'backend probe failed: Worker egress could not reach baseUrl (DNS/TLS/firewall?)',
          };
        }
      }

      const [health, volumes] = await Promise.all([check('/health'), check('/user/volumes')]);
      await scope
        .get(Tokens.BackendService)
        .recordProbe(email, row.slug, health.status)
        .catch(() => undefined);
      return c.json({
        slug: row.slug,
        baseUrl: row.base_url,
        health,
        volumes,
      });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });
}

export { registerBackendRoutes };
