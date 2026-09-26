import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import {
  fetchWithTimeout,
  getProxyTimeoutMs,
  stripTrailingSlashes,
} from '@durable-dav-router/backend-services/router';
import { BaseRoute } from '@/endpoints/IBaseRoute';

type App = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function toBackendJson(r: {
  slug: string;
  base_url: string;
  display_name: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  last_status: number | null;
}) {
  return {
    slug: r.slug,
    baseUrl: r.base_url,
    displayName: r.display_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
    lastStatus: r.last_status,
  };
}

async function probeBackendHealth(baseUrl: string, timeoutMs: number): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(new Request(`${stripTrailingSlashes(baseUrl)}/health`), { method: 'GET' }, timeoutMs);
    return res.status;
  } catch {
    return null;
  }
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
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string; baseUrl?: string; displayName?: string | null };
    if (!body.slug || !body.baseUrl) {
      return c.json({ Exception: { Type: 'BadRequest', Message: 'slug and baseUrl are required' } }, 400);
    }
    try {
      const created = await scope.get(Tokens.BackendService).createBackend({
        ownerEmail: email,
        slug: body.slug,
        baseUrl: body.baseUrl,
        displayName: body.displayName ?? null,
      });
      // Best-effort liveness probe; never blocks creation.
      const timeoutMs = getProxyTimeoutMs(c.env);
      const status = await probeBackendHealth(created.base_url, timeoutMs);
      await scope.get(Tokens.BackendService).recordProbe(email, created.slug, status);
      const refreshed = await scope.get(Tokens.BackendService).getBackend(email, created.slug).catch(() => created);
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
    const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: string; displayName?: string | null };
    try {
      const updated = await scope.get(Tokens.BackendService).updateBackend(email, c.req.param('slug') ?? '', body);
      const timeoutMs = getProxyTimeoutMs(c.env);
      const status = await probeBackendHealth(updated.base_url, timeoutMs);
      await scope.get(Tokens.BackendService).recordProbe(email, updated.slug, status);
      const refreshed = await scope.get(Tokens.BackendService).getBackend(email, updated.slug).catch(() => updated);
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
      return c.json({ ok: true });
    } catch (error) {
      return BaseRoute.toErrorResponse(c as never, error);
    }
  });
}

export { registerBackendRoutes };
