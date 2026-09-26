import { AbstractEntrypointWorker } from '@durable-dav-router/backend-runtime/base';
import { fromHono } from 'chanfana';
import type { HonoOpenAPIRouterType } from 'chanfana';
import { Hono } from 'hono';
import { MiddlewareHandlers, securityHeaders } from '@/middleware';
import { scopeMiddleware } from '@/middleware/scopeMiddleware';
import { registerBackendRoutes } from './routes/BackendRoutes';
import { registerAggregatedVolumeRoutes } from './routes/AggregatedVolumeRoutes';
import { registerRouterDavProxyRoutes } from './routes/RouterDavProxyRoutes';
import { registerUserProfileRoutes } from './routes/UserRoutes';
import { SPA_HTML } from '@/generated/spa-shell';

type AppRouter = HonoOpenAPIRouterType<{
  Bindings: Env;
  Variables: { AuthenticatedUserEmailAddress: string };
}>;

function acceptsHtml(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').includes('text/html');
}

class DurableDavRouterWorker extends AbstractEntrypointWorker {
  protected readonly app: AppRouter;

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
    return this.app.fetch(request, env, ctx);
  }

  protected onScheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Stateless router: no cron tasks. Present only to satisfy the base class.
    return Promise.resolve();
  }
}

export { DurableDavRouterWorker };
