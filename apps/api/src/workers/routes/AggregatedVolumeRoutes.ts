import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import {
  describeBackendFailure,
  explicitBackendSlug,
  fetchWithTimeout,
  getProxyTimeoutMs,
  invalidateCachedRoute,
  joinBackendUrl,
  joinBackendUrlWithoutSelector,
  selectBackend,
  truncateSnippet,
} from '@durable-dav-router/backend-services/router';
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';
import { NotFoundError } from '@durable-dav-router/backend-errors';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { AuthenticatedAccount, RouterEnv } from '@/requestContext';

type App = Hono<RouterEnv>;

function kvOf(scope: { get: (token: never) => KvCache }): KvCache | null {
  try {
    return scope.get(Tokens.KvCache as never);
  } catch {
    return null;
  }
}

/**
 * Headers for a management-plane proxy to a backend.
 *
 * The caller's Cloudflare Access credentials are forwarded verbatim: the
 * backend enforces its own access, and the router stores no credentials of its
 * own. `Accept`/`User-Agent` identify the router so a backend can tell a proxied
 * request from a direct one.
 */
function authForwardHeaders(request: Request): Headers {
  const out = new Headers();
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ?? request.headers.get('cf-access-jwt-assertion');
  if (jwt) out.set('Cf-Access-Jwt-Assertion', jwt);
  const auth = request.headers.get('Authorization');
  if (auth) out.set('Authorization', auth);
  const cookie = request.headers.get('Cookie');
  if (cookie) out.set('Cookie', cookie);
  out.set('Accept', 'application/json');
  out.set('User-Agent', 'durable-dav-router');
  return out;
}

/**
Methods that never carry a request body.
*/
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/**
 * Forward a management request to a backend and pass the response through.
 *
 * The router adds no interpretation here: the backend owns volume semantics, so
 * its status, body, and content type are returned verbatim. A transport failure
 * becomes a 502 rather than an exception, because "the backend is unreachable"
 * is a real answer for a proxy.
 */
async function forwardToBackend(request: Request, target: string, env: Env, body: ReadableStream | string | null): Promise<Response> {
  const headers = authForwardHeaders(request);
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
    const isTimeout = error instanceof Error && (error.name === 'AbortError' || /aborted|timeout/i.test(error.message));
    console.warn(
      `backend ${new URL(target).origin} ${isTimeout ? 'timed out' : 'unreachable'} for ${method}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Response(isTimeout ? 'Backend timed out' : 'Backend unreachable', { status: isTimeout ? 504 : 502 });
  }
  const text = await res.text().catch(() => '');
  return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
}

interface ProxyOneContext {
  req: {
    raw: Request;
    param: (n: string) => string | undefined;
    query: (k: string) => string | undefined;
    header: (k: string) => string | undefined;
  };
  env: Env;
  // oxlint-disable-next-line no-explicit-any
  json: (data: unknown, status?: number) => any;
}

/**
 * The caller's account, for a helper that takes a narrowed context type.
 *
 * These two helpers exist because the WebDAV proxy needs a structural subset of
 * Hono's context (only `req` and `env`), which is why they are reached through
 * `c as never`. The `get` shape is spelled out rather than borrowed from
 * `RouterContext` because the parameter type genuinely is not the app's context
 * — and a silent `undefined` here would become an empty backend list, i.e. a
 * caller seeing "no backends" rather than a 401.
 */
function authenticatedAccount(c: unknown): AuthenticatedAccount {
  const account = (c as { get?: (key: 'AuthenticatedAccount') => AuthenticatedAccount | undefined }).get?.('AuthenticatedAccount');
  if (!account) throw new NotFoundError('Not authenticated');
  return account;
}

// Single-bucket management proxies verbatim to the owning backend.
// `?backend=` (or `X-Backend`) disambiguates when several backends exist;
// a lone backend is used implicitly, multiple without selector → 409.
async function proxyOne(c: ProxyOneContext): Promise<Response> {
  const scope = BaseRoute.getScope(c as never);
  const account = authenticatedAccount(c);
  // Named `volumeOwner`, not `owner`: this is the *per-backend* username segment
  // of the path, which is a different namespace from the router account. The two
  // collided once the account arrived as an object, and the WebDAV owner-routing
  // key is the one thing that must not be confused with an identity.
  const volumeOwner = c.req.param('owner') ?? '';
  const volume = c.req.param('volume') ?? '';
  try {
    const backends = await scope.get(Tokens.BackendService).listBackends(account);
    const backend = selectBackend(backends, explicitBackendSlug(c));
    const target = joinBackendUrlWithoutSelector(
      backend.base_url,
      `/user/volumes/${encodeURIComponent(volumeOwner)}/${encodeURIComponent(volume)}`,
      new URL(c.req.raw.url).search,
    );
    const res = await forwardToBackend(c.req.raw, target, c.env, c.req.raw.body);
    // Volume deletion changes future probe outcomes → evict the cached owner.
    if (c.req.raw.method === 'DELETE' && res.status >= 200 && res.status < 300) {
      await invalidateCachedRoute(kvOf(scope as never), volumeOwner, volume).catch(() => undefined);
    }
    return res;
  } catch (error) {
    return BaseRoute.toErrorResponse(c as never, error);
  }
}

interface ProxySubpathContext {
  req: { raw: Request; param: (n: string) => string | undefined };
  env: Env;
  json: (data: unknown, status?: number) => Response;
}

// Browser-plane + credential subpaths (`/files/*`, `/credentials/*`, …)
// proxy verbatim to the owning backend so the uniform WebUI manages each
// backend through one shape.
async function proxySubpath(c: ProxySubpathContext): Promise<Response> {
  const scope = BaseRoute.getScope(c as never);
  const account = authenticatedAccount(c);
  try {
    const backends = await scope.get(Tokens.BackendService).listBackends(account);
    const raw = c.req.raw;
    // Read the selector from the raw request rather than the Hono helpers, then
    // reuse the shared reader so both planes agree on precedence and trimming.
    const selector = explicitBackendSlug({
      req: {
        query: (k: string) => new URL(raw.url).searchParams.get(k) ?? undefined,
        header: (k: string) => raw.headers.get(k) ?? undefined,
      },
    });
    const backend = selectBackend(backends, selector);
    const incomingUrl = new URL(raw.url);
    // The full path is preserved so the backend sees the same resource shape the
    // caller asked for; only the router's own selector is stripped.
    return forwardToBackend(
      raw,
      joinBackendUrlWithoutSelector(backend.base_url, incomingUrl.pathname, incomingUrl.search),
      c.env,
      raw.body,
    );
  } catch (error) {
    return BaseRoute.toErrorResponse(c as never, error);
  }
}

function registerAggregatedVolumeRoutes(app: App): void {
  // Create a bucket on the selected backend (`?backend=` required when more
  // than one backend exists; proxies verbatim to backend POST /user/volumes).
  app.post('/user/volumes', async (c) => {
    const scope = BaseRoute.getScope(c);
    const account = c.get('AuthenticatedAccount');
    try {
      const backends = await scope.get(Tokens.BackendService).listBackends(account);
      const backend = selectBackend(backends, explicitBackendSlug(c));
      const body = await c.req.json().catch(() => ({}));
      // Re-serialize the parsed body rather than streaming `c.req.raw.body`, so
      // the request is replayable and `Content-Length` is unambiguous. Volume
      // creation payloads are small.
      const headers = authForwardHeaders(c.req.raw);
      headers.set('Content-Type', 'application/json');
      const res = await forwardToBackend(c.req.raw, joinBackendUrl(backend.base_url, '/user/volumes'), c.env, JSON.stringify(body));
      const text = await res.text().catch(() => '');
      if (res.status >= 200 && res.status < 300) {
        // The created volume's owner is the WebDAV routing key, so cache it. A
        // parse or write failure must not fail a creation that already
        // succeeded at the backend.
        try {
          const created = JSON.parse(text) as { owner?: unknown };
          if (typeof created.owner === 'string' && created.owner.trim()) {
            await scope
              .get(Tokens.BackendService)
              .recordBackendUsername(account, backend.slug, created.owner.trim())
              .catch(() => undefined);
          }
        } catch {
          // ignore cache failures — creation already succeeded
        }
      }
      return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  // Aggregated bucket list across all registered backends (fail-soft per backend).
  app.get('/user/volumes', async (c) => {
    const scope = BaseRoute.getScope(c);
    const account = c.get('AuthenticatedAccount');
    const onlySlug = explicitBackendSlug(c);
    try {
      let backends = await scope.get(Tokens.BackendService).listBackends(account);
      if (onlySlug) backends = backends.filter((b) => b.slug.toLowerCase() === onlySlug.toLowerCase());
      if (backends.length === 0) return c.json({ volumes: [], backends: [] });
      const timeoutMs = getProxyTimeoutMs(c.env);
      const settled = await Promise.allSettled(
        backends.map(async (b) => {
          const url = joinBackendUrl(b.base_url, '/user/volumes');
          const res = await fetchWithTimeout(
            new Request(url),
            { method: 'GET', headers: authForwardHeaders(c.req.raw), redirect: 'manual' },
            timeoutMs,
          );
          if (!res.ok) {
            const snippet = truncateSnippet(await res.text().catch(() => ''), 200);
            throw Object.assign(new Error(`backend ${b.slug} ${describeBackendFailure(res.status, snippet)}`), {
              backendSlug: b.slug,
              backendStatus: res.status,
            });
          }
          const data = (await res.json().catch(() => ({}))) as { volumes?: Array<Record<string, unknown>> };
          const volumes = (data.volumes ?? []).map((v) => ({ ...v, backend: b.slug, backendBaseUrl: b.base_url }));
          return { slug: b.slug, ok: true as const, volumes };
        }),
      );
      const volumes: Array<Record<string, unknown>> = [];
      const backendStatus = settled.map((r, i) => {
        const slug = backends[i].slug;
        if (r.status === 'fulfilled') {
          volumes.push(...r.value.volumes);
          return { slug, ok: true, status: 200 };
        }
        const reason = r.reason as Error & { backendStatus?: number };
        const upstreamStatus = typeof reason?.backendStatus === 'number' ? reason.backendStatus : null;
        const isTimeout = reason?.name === 'AbortError' || /aborted|timeout/i.test(reason?.message ?? '');
        const status = upstreamStatus ?? (isTimeout ? 504 : 502);
        const message = reason instanceof Error ? reason.message : 'backend unreachable';
        console.warn('backend fan-out failed', { slug, status, error: message.slice(0, 300) });
        return { slug, ok: false, status, error: message };
      });
      return c.json({ volumes, backends: backendStatus });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  app.get('/user/volumes/:owner/:volume', async (c) => proxyOne(c as never));
  app.patch('/user/volumes/:owner/:volume', async (c) => proxyOne(c as never));
  app.delete('/user/volumes/:owner/:volume', async (c) => proxyOne(c as never));

  app.on(
    [
      'GET',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'PROPFIND',
      'PROPPATCH',
      'MKCOL',
      'COPY',
      'MOVE',
      'LOCK',
      'UNLOCK',
      'HEAD',
      'OPTIONS',
    ] as never[],
    '/user/volumes/:owner/:volume/*',
    async (c) => proxySubpath(c as never),
  );
}

export { registerAggregatedVolumeRoutes };
