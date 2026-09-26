import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import {
  buildProxiedHeaders,
  fetchWithTimeout,
  filterProxiedResponseHeaders,
  getProxyTimeoutMs,
  joinBackendUrl,
  resolveBackend,
  stripSlashes,
} from '@durable-dav-router/backend-services/router';
import { SUPPORT_METHODS, applyCors } from '@durable-dav-router/webdav';
import { BaseRoute } from '@/endpoints/IBaseRoute';

type App = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

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

async function handleProxy(
  c: { req: { raw: Request }; env: Env; executionCtx?: unknown },
  owner: string,
  volume: string,
  inner: string,
): Promise<Response> {
  const method = c.req.raw.method;
  if (!SUPPORT_METHODS.includes(method)) {
    return applyCors(
      new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', ') } }),
      c.req.raw,
    );
  }
  const scope = BaseRoute.getScope(c as never);
  // Router stores no user rows for anonymous public reads; only authenticated
  // management calls need an email. Anonymous DAV passes through with no
  // `/user/*` identity — the backend enforces public-vs-private itself.
  let backends: Array<{ slug: string; base_url: string }> = [];
  try {
    const email = await scope
      .get(Tokens.AccessAuthService)
      .getAuthenticatedUserEmail(c.req.raw, (c as { executionCtx?: unknown }).executionCtx as never)
      .catch(() => null);
    if (email) {
      await scope.get(Tokens.UserService).upsertUser(email).catch(() => undefined);
      backends = await scope.get(Tokens.BackendService).listBackends(email).catch(() => []);
    }
  } catch {
    backends = [];
  }
  // Anonymous callers cannot enumerate private backends. They must address the
  // backend explicitly via `?backend=` host mapping is out of scope for the
  // flat-path scheme — for now anonymous requires the backend to be hinted and
  // resolvable without identity is unsupported, so fail closed with 401 unless
  // the request carries an authenticated identity above.
  if (backends.length === 0) {
    return applyCors(
      Response.json({ Exception: { Type: 'Unauthorized', Message: 'Sign in to route WebDAV requests' } }, {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="durable-dav-router"' },
      }),
      c.req.raw,
    );
  }
  const resolved = resolveBackend(backends as never, explicitBackendSlug(c.req.raw));
  if (resolved.kind === 'not-found') {
    return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
  }
  if (resolved.kind === 'ambiguous') {
    return applyCors(
      Response.json(
        {
          Exception: { Type: 'Conflict', Message: 'Multiple backends match; retry with ?backend=<slug>' },
          backends: resolved.backends.map((b) => b.slug),
        },
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
      c.req.raw,
    );
  }
  const backend = resolved.backend;
  const incomingUrl = new URL(c.req.raw.url);
  const suffix = inner ? `/${inner}` : '';
  // Preserve sub-path encoding segment-wise; backend origin join is verbatim.
  const target = joinBackendUrl(backend.base_url, `/${owner}/${volume}${suffix}${incomingUrl.search}`);
  const routerOrigin = incomingUrl.origin;
  const headers = buildProxiedHeaders(c.req.raw, routerOrigin, backend.base_url);
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const timeoutMs = getProxyTimeoutMs(c.env);
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      new Request(target),
      { method, headers, body: hasBody ? c.req.raw.body : undefined, ...(hasBody && { duplex: 'half' }) },
      timeoutMs,
    );
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? 'Backend timed out' : 'Backend unreachable';
    return applyCors(new Response(message, { status: 502 }), c.req.raw);
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
    const base = `/${owner}/${volume}`;
    const suffix = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : '';
    const inner = stripSlashes(suffix);
    return handleProxy(c, owner, volume, inner);
  });
  app.on(methods, '/:owner/:volume', async (c) => {
    const owner = c.req.param('owner') ?? '';
    const volume = c.req.param('volume') ?? '';
    return handleProxy(c, owner, volume, '');
  });
}

export { registerRouterDavProxyRoutes };
