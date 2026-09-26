import type { Next } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import type { AccessIdentityContext } from '@durable-dav-router/backend-services/auth';
import { ErrorSanitizationUtil } from '@durable-dav-router/shared/utils';
import { BaseRoute } from '../endpoints/IBaseRoute';
import type { HonoContext } from '../endpoints/IBaseRoute';

type RequestContext = HonoContext;

function getScope(c: RequestContext): ReturnType<typeof BaseRoute.getScope> {
  return BaseRoute.getScope(c);
}

/**
 * Resolve the caller's identity and record it for the request.
 *
 * The user row is upserted here rather than in each handler so `/user/*` has a
 * row to reference: `router_backends.owner_email` is a foreign key into
 * `users(email)`, so a backend registered before the user row existed would
 * fail to insert.
 */
async function authenticateUserIdentity(c: RequestContext): Promise<string> {
  const scope = getScope(c);
  const email = await scope
    .get(Tokens.AccessAuthService)
    .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as unknown as AccessIdentityContext);
  await scope.get(Tokens.UserService).upsertUser(email);
  return email;
}

/**
 * Guard for `/user/*`.
 *
 * Errors go through `BaseRoute.toErrorResponse`, which owns the status mapping
 * and the rule that a 5xx body is masked. Mapping statuses here as well would
 * be a second place to keep in sync, and this handler is the one place a
 * failure happens *before* a route is reached.
 */
async function userAuthenticationHandler(c: RequestContext, next: Next): Promise<Response | void> {
  try {
    c.set('AuthenticatedUserEmailAddress', await authenticateUserIdentity(c));
  } catch (error: unknown) {
    // Only an authentication failure is expected here; anything else is a bug
    // and is logged with its cause.
    if (!(error instanceof Error) || error.name !== 'ServiceError') {
      console.error('userAuthentication failed:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    }
    return BaseRoute.toErrorResponse(c, error);
  }
  await next();
}

class MiddlewareHandlers {
  public static userAuthentication(): (c: RequestContext, next: Next) => Promise<Response | void> {
    return userAuthenticationHandler;
  }
}

export { MiddlewareHandlers, userAuthenticationHandler, authenticateUserIdentity };
export type { RequestContext };
