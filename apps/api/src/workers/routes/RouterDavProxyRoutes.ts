import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import {
  buildProxiedHeaders,
  fetchWithTimeout,
  filterProxiedResponseHeaders,
  getProxyTimeoutMs,
  joinBackendUrlWithoutSelector,
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
  trailingSlash: boolean,
): Promise<Response> {
  const method = c.req.raw.method;
  if (!SUPPORT_METHODS.includes(method)) {
    return applyCors(
      new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', ') } }),
      c.req.raw,
    );
  }
  const scope = BaseRoute.getScope(c as never);
  // WebDAV proxy is owner-routed, not requester-routed. Native clients only
  // send per-bucket Basic `Authorization` — they never carry Cloudflare Access
  // JWT — so requiring an Access identity here breaks every client (401).
  // Resolve the volume owner's backends via username, then let the backend
  // enforce public-vs-private itself with the verbatim-proxied credentials.
  let ownerEmail: string | null = null;
  try {
    const user = await scope.get(Tokens.UserService).getByUsername(owner);
    ownerEmail = user?.email ?? null;
  } catch {
    ownerEmail = null;
  }
  // Fallback to the global namespace registry (covers legacy rows without a
  // `users.username` and renamed-away handles, which stay reserved).
  if (!ownerEmail) {
    try {
      const nsDao = await scope.get(Tokens.NamespaceDAO)();
      const ns = await (nsDao as { get: (k: string) => Promise<{ user_email?: string | null } | null> }).get(
        owner.toLowerCase(),
      ).catch(() => null);
      ownerEmail = ns?.user_email ?? null;
    } catch {
      ownerEmail = null;
    }
  }
  if (!ownerEmail) {
    return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
  }
  let backends: Array<{ slug: string; base_url: string }> = [];
  try {
    backends = await scope.get(Tokens.BackendService).listBackends(ownerEmail).catch(() => []);
  } catch {
    backends = [];
  }
  if (backends.length === 0) {
    return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
  }
  const resolved = resolveBackend(backends as never, explicitBackendSlug(c.req.raw));
  if (resolved.kind === 'not-found') {
    return applyCors(new Response('Not Found', { status: 404 }), c.req.raw);
  }
  if (resolved.kind === 'ambiguous') {
    // Unauthenticated WebDAV callers get no slug enumeration — they already
    // know their slugs from the authenticated dashboard (`/user/volumes`).
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
  const incomingUrl = new URL(c.req.raw.url);
  const encodedBase = `/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`;
  let suffix = inner ? `/${inner}` : '';
  if (trailingSlash && suffix !== '/') suffix = suffix ? `${suffix}/` : '/';
  // Never leak the router `?backend=` selector to the backend.
  const target = joinBackendUrlWithoutSelector(backend.base_url, `${encodedBase}${suffix}`, incomingUrl.search);
  const routerOrigin = incomingUrl.origin;
  const headers = buildProxiedHeaders(c.req.raw, routerOrigin, backend.base_url);
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const timeoutMs = getProxyTimeoutMs(c.env);
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
}

export { registerRouterDavProxyRoutes };
