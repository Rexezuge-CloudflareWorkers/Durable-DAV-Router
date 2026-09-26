import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import {
  fetchWithTimeout,
  getProxyTimeoutMs,
  joinBackendUrl,
  resolveBackend,
} from '@durable-dav-router/backend-services/router';
import { BaseRoute } from '@/endpoints/IBaseRoute';

type App = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function authForwardHeaders(request: Request): Headers {
  const out = new Headers();
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ?? request.headers.get('cf-access-jwt-assertion');
  if (jwt) out.set('Cf-Access-Jwt-Assertion', jwt);
  const auth = request.headers.get('Authorization');
  if (auth) out.set('Authorization', auth);
  const cookie = request.headers.get('Cookie');
  if (cookie) out.set('Cookie', cookie);
  return out;
}

function explicitBackendSlug(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string | null {
  const q = c.req.query('backend');
  if (q?.trim()) return q.trim();
  const h = c.req.header('X-Backend');
  return h?.trim() ? h.trim() : null;
}

interface ProxyOneContext {
  req: { raw: Request; param: (n: string) => string | undefined; query: (k: string) => string | undefined; header: (k: string) => string | undefined };
  env: Env;
  // oxlint-disable-next-line no-explicit-any
  json: (data: unknown, status?: number) => any;
}

// Single-bucket management proxies verbatim to the owning backend.
// `?backend=` (or `X-Backend`) disambiguates when several backends exist;
// a lone backend is used implicitly, multiple without selector → 409.
async function proxyOne(c: ProxyOneContext): Promise<Response> {
  const scope = BaseRoute.getScope(c as never);
  const email = (c as unknown as { get: (k: string) => string }).get?.('AuthenticatedUserEmailAddress') ?? '';
  const owner = c.req.param('owner') ?? '';
  const volume = c.req.param('volume') ?? '';
  try {
    const backends = await scope.get(Tokens.BackendService).listBackends(email);
    const resolved = resolveBackend(backends, explicitBackendSlug(c));
    if (resolved.kind === 'not-found') return c.json({ Exception: { Type: 'NotFound', Message: 'No backend matches this request' } }, 404);
    if (resolved.kind === 'ambiguous') {
      return c.json(
        { Exception: { Type: 'Conflict', Message: 'Multiple backends match; retry with ?backend=<slug>' }, backends: resolved.backends.map((b) => b.slug) },
        409,
      );
    }
    const backend = resolved.backend;
    const incomingUrl = new URL(c.req.raw.url);
    const target = joinBackendUrl(
      backend.base_url,
      `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}${incomingUrl.search}`,
    );
    const method = c.req.raw.method;
    const hasBody = !['GET', 'HEAD'].includes(method);
    const headers = authForwardHeaders(c.req.raw);
    const contentType = c.req.raw.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);
    const timeoutMs = getProxyTimeoutMs(c.env);
    const res = await fetchWithTimeout(
      new Request(target),
      { method, headers, body: hasBody ? c.req.raw.body : undefined, ...(hasBody && { duplex: 'half' }) },
      timeoutMs,
    );
    const text = await res.text().catch(() => '');
    return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
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
  const email = (c as unknown as { get: (k: string) => string }).get?.('AuthenticatedUserEmailAddress') ?? '';
  try {
    const backends = await scope.get(Tokens.BackendService).listBackends(email);
    const raw = c.req.raw;
    let explicit: string | null = null;
    try {
      explicit = new URL(raw.url).searchParams.get('backend');
    } catch {
      explicit = null;
    }
    const headerFallback = raw.headers.get('X-Backend');
    const resolved = resolveBackend(backends, explicit?.trim() ? explicit.trim() : (headerFallback?.trim() ? headerFallback.trim() : null));
    if (resolved.kind === 'not-found') return c.json({ Exception: { Type: 'NotFound', Message: 'No backend matches this request' } }, 404);
    if (resolved.kind === 'ambiguous') {
      return c.json(
        { Exception: { Type: 'Conflict', Message: 'Multiple backends match; retry with ?backend=<slug>' }, backends: resolved.backends.map((b) => b.slug) },
        409,
      );
    }
    const incomingUrl = new URL(raw.url);
    const target = joinBackendUrl(resolved.backend.base_url, `${incomingUrl.pathname}${incomingUrl.search}`);
    const method = raw.method;
    const hasBody = !['GET', 'HEAD'].includes(method);
    const headers = authForwardHeaders(raw);
    const contentType = raw.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);
    const timeoutMs = getProxyTimeoutMs(c.env);
    const res = await fetchWithTimeout(
      new Request(target),
      { method, headers, body: hasBody ? raw.body : undefined, ...(hasBody && { duplex: 'half' }) },
      timeoutMs,
    );
    const text = await res.text().catch(() => '');
    return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
  } catch (error) {
    return BaseRoute.toErrorResponse(c as never, error);
  }
}

function registerAggregatedVolumeRoutes(app: App): void {
  // Create a bucket on the selected backend (`?backend=` required when more
  // than one backend exists; proxies verbatim to backend POST /user/volumes).
  app.post('/user/volumes', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const backends = await scope.get(Tokens.BackendService).listBackends(email);
      const resolved = resolveBackend(backends, explicitBackendSlug(c));
      if (resolved.kind === 'not-found') return c.json({ Exception: { Type: 'NotFound', Message: 'No backend matches this request' } }, 404);
      if (resolved.kind === 'ambiguous') {
        return c.json(
          { Exception: { Type: 'Conflict', Message: 'Multiple backends match; retry with ?backend=<slug>' }, backends: resolved.backends.map((b) => b.slug) },
          409,
        );
      }
      const body = await c.req.json().catch(() => ({}));
      const timeoutMs = getProxyTimeoutMs(c.env);
      const res = await fetchWithTimeout(
        new Request(joinBackendUrl(resolved.backend.base_url, '/user/volumes')),
        { method: 'POST', headers: new Headers({ ...Object.fromEntries(authForwardHeaders(c.req.raw)), 'Content-Type': 'application/json' }), body: JSON.stringify(body) },
        timeoutMs,
      );
      const text = await res.text().catch(() => '');
      return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  // Aggregated bucket list across all registered backends (fail-soft per backend).
  app.get('/user/volumes', async (c) => {
    const scope = BaseRoute.getScope(c);
    const email = c.get('AuthenticatedUserEmailAddress');
    const onlySlug = explicitBackendSlug(c);
    try {
      let backends = await scope.get(Tokens.BackendService).listBackends(email);
      if (onlySlug) backends = backends.filter((b) => b.slug.toLowerCase() === onlySlug.toLowerCase());
      if (backends.length === 0) return c.json({ volumes: [], backends: [] });
      const timeoutMs = getProxyTimeoutMs(c.env);
      const settled = await Promise.allSettled(
        backends.map(async (b) => {
          const url = joinBackendUrl(b.base_url, '/user/volumes');
          const res = await fetchWithTimeout(new Request(url), { method: 'GET', headers: authForwardHeaders(c.req.raw) }, timeoutMs);
          if (!res.ok) throw new Error(`backend ${b.slug} responded ${res.status}`);
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
        return { slug, ok: false, status: 502, error: r.reason instanceof Error ? r.reason.message : 'backend unreachable' };
      });
      return c.json({ volumes, backends: backendStatus });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });

  app.get('/user/volumes/:owner/:volume', async (c) => proxyOne(c as never));
  app.patch('/user/volumes/:owner/:volume', async (c) => proxyOne(c as never));
  app.delete('/user/volumes/:owner/:volume', async (c) => proxyOne(c as never));

  app.on(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'HEAD', 'OPTIONS'] as never[], '/user/volumes/:owner/:volume/*', async (c) =>
    proxySubpath(c as never),
  );
}

export { registerAggregatedVolumeRoutes };
