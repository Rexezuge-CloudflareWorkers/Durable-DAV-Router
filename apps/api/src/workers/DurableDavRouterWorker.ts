import { AbstractEntrypointWorker } from '@durable-dav-router/backend-runtime/base';
import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import { fromHono } from 'chanfana';
import type { HonoOpenAPIRouterType } from 'chanfana';
import { Hono } from 'hono';
import { MiddlewareHandlers, registerRateLimits, securityHeaders } from '@/middleware';
import { scopeMiddleware } from '@/middleware/scopeMiddleware';
import { registerBackendRoutes } from './routes/BackendRoutes';
import { registerAggregatedVolumeRoutes } from './routes/AggregatedVolumeRoutes';
import { registerRouterDavProxyRoutes } from './routes/RouterDavProxyRoutes';
import { registerUserProfileRoutes } from './routes/UserRoutes';
import { SPA_HTML } from '@/generated/spa-shell';
import { applyCors } from '@durable-dav-router/webdav';

type AppRouter = HonoOpenAPIRouterType<{
  Bindings: Env;
  Variables: { AuthenticatedUserEmailAddress: string };
}>;

function acceptsHtml(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').includes('text/html');
}

class DurableDavRouterWorker extends AbstractEntrypointWorker {
  protected readonly app: AppRouter;
  // Configuration problems are silent at runtime — a bad numeric var falls back
  // to its default, an auth bypass in production authenticates everyone as one
  // identity — so they must be reported exactly once, not per request.
  private configChecked = false;

  constructor() {
    super();

    const app = new Hono<{
      Bindings: Env;
      Variables: { AuthenticatedUserEmailAddress: string };
    }>();

    app.use('*', securityHeaders());
    app.onError((error, c) => {
      console.error('Unhandled worker error', error instanceof Error ? (error.stack ?? error.message) : error);
      return c.json({ Exception: { Type: 'InternalServerError', Message: 'Internal Server Error.' } }, 500);
    });

    app.get('/health', (c) => c.json({ ok: true, service: 'durable-dav-router' }));

    // Web SPA shell (Vite build embeds `apps/web/dist/index.html` into
    // `apps/api/src/generated/spa-shell.ts`; no per-request scope needed).
    // No profile shell: usernames are per-backend, the router has no global
    // user pages. `/:owner/:volume` below serves VolumeView for browsers.
    app.get('/', (c) => c.html(SPA_HTML));
    app.get('/new', (c) => c.html(SPA_HTML));
    app.get('/backends/new', (c) => c.html(SPA_HTML));
    app.get('/settings', (c) => c.html(SPA_HTML));

    app.use('*', scopeMiddleware);

    // A CORS preflight must be answered before authentication: preflights carry
    // no credentials by design, so requiring auth here can only break clients,
    // and a preflight for any `/user/*` request used to be answered with 401 so
    // browsers never issued the real call.
    //
    // It must answer *only* preflights. A Fetch-spec preflight carries
    // `Access-Control-Request-Method`; a WebDAV client sends at most `Origin`.
    // This handler is terminal, so answering every `OPTIONS` also swallowed the
    // DAV capability probe — `OPTIONS` is one of the 12 `SUPPORT_METHODS` — and
    // replied `204` with no `DAV:` header. RFC 4918 §9.1 requires that header,
    // and clients that probe capabilities on connect aborted outright ("No
    // Content"). Anything without `Access-Control-Request-Method` falls through
    // to the proxy below, which forwards the backend's own `DAV:`/`Allow:`
    // advertisement (both are in `PASSTHROUGH_RESPONSE_HEADERS`).
    app.options('*', async (c, next) => {
      return c.req.header('Access-Control-Request-Method') ? applyCors(new Response(null, { status: 204 }), c.req.raw) : next();
    });

    // Before `/user/*` auth so the limiter can key on the authenticated email
    // once the identity is known; the identity falls back to the trusted
    // connecting IP for anonymous WebDAV traffic.
    registerRateLimits(app);

    app.use('/user/*', MiddlewareHandlers.userAuthentication());

    registerBackendRoutes(app);
    registerAggregatedVolumeRoutes(app);
    registerUserProfileRoutes(app);

    // Volume-root content negotiation: browser document navigations
    // (`Accept: text/html`) get the SPA shell, whose VolumeView drives
    // subpaths client-side via `?backend=&path=`; WebDAV and file clients
    // (`Accept: */*`, `Depth`, …) fall through to the backend proxy below.
    // Registered after `/user/*` so API JSON responses always win.
    app.use('/:owner/:volume', async (c, next) => {
      if (c.req.method === 'GET' && acceptsHtml(c.req.raw)) return c.html(SPA_HTML);
      await next();
    });
    registerRouterDavProxyRoutes(app);

    const openapi: AppRouter = fromHono(app, { docs_url: '/docs' });
    this.app = openapi;
  }

  protected async onRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!this.configChecked) {
      this.configChecked = true;
      try {
        for (const warning of AppConfiguration.fromEnv(env).validate()) {
          console.error(`[config] ${warning}`);
        }
      } catch (error) {
        console.error('[config] validation failed:', error instanceof Error ? error.message : String(error));
      }
    }
    return this.app.fetch(request, env, ctx);
  }
}

export { DurableDavRouterWorker };
