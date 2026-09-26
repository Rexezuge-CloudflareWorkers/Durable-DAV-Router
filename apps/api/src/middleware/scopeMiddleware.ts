import type { Context, Next } from 'hono';
import { asScopedContext, setRequestScope } from '@durable-dav-router/backend-runtime/di';
import { createRequestScope } from '@durable-dav-router/backend-services/composition';

type ScopeContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

/**
 * Single-scope-per-request middleware (Otter composition-root pattern).
 * Creates one `Container` per request and stores it on the Hono context.
 * Handlers resolve via `getRequestScope(c)` instead of calling
 * `createRequestScope(c.env)` per handler (which minted N scopes per request
 * and defeated singleton memoization).
 */
async function scopeMiddleware(c: ScopeContext, next: Next): Promise<Response | void> {
  setRequestScope(asScopedContext(c), createRequestScope(c.env));
  await next();
}

export { scopeMiddleware };
