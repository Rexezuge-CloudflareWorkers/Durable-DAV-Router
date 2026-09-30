import type { Context } from 'hono';
import type { AccountIdentity } from '@durable-dav-router/backend-services/identity';

/**
 * The authenticated caller's account, as recorded on the request by
 * `userAuthenticationHandler`.
 *
 * This replaces the former `AuthenticatedUserEmailAddress: string`.
 * The address Access asserts is an *attribute* of the account, not its identity:
 * keeping only the string meant every owner-scoped query was keyed on a value the
 * user could not change without losing access to everything registered under it.
 * The id is the identity, and it survives an address change.
 *
 * `anchorEmail` is the frozen value `router_backends.owner_email` stores. It is
 * deliberately present on the context: it is the only way to satisfy that
 * foreign key, and it is not something a route should compute.
 */
type AuthenticatedAccount = AccountIdentity;

/**
 * Hono environment shared by every route, middleware, and the worker itself.
 *
 * Declared once because the same `{ Bindings: Env; Variables: ... }` pair was
 * copy-pasted across seven files, and the drift it invites is invisible until a
 * route reads a variable the middleware never set.
 */
type RouterEnv = { Bindings: Env; Variables: { AuthenticatedAccount: AuthenticatedAccount } };

/**
 * What `BaseRoute`'s statics and the route helpers actually need from a request.
 *
 * Declared structurally rather than as Hono's `Context<RouterEnv>` because the
 * route helpers take a *narrowed* subset: `handleProxy` needs `req.raw` and
 * `env` and no variable at all, while `proxyOne` needs `req.param`. Typing both
 * against the full context made the narrowing unrepresentable, and every call
 * site that did it paid for it with `c as never` — 27 of them in `apps/api`,
 * 11 of them existing only to reach `BaseRoute.toErrorResponse`.
 *
 * Hono's `Context` satisfies this, and so does the structural double the route
 * tests build, so both can call the same helpers with no cast at either end. The
 * cost is that a mistake a real `Context` would catch — reading a variable that
 * `scopeMiddleware` never set — is now a type error at the property rather than
 * at the call, which the same file's `RouterEnv.Variables` still pins.
 */
type RouteContext = {
  req: {
    /**
    The untouched inbound request. Never re-read after a body has been consumed.
    */
    raw: Request;
    param: (name: string) => string | undefined;
    query: (key: string) => string | undefined;
    header: (name: string) => string | undefined;
    /**
    Parses the body. Only the JSON management plane calls this; the DAV plane streams.
    */
    json: () => Promise<unknown>;
  };
  env: Env;
  /**
  Present on a full context; the DAV proxy deliberately does not depend on it.
  */
  json: (data: unknown, status?: number) => Response;
  get: <K extends keyof RouterEnv['Variables']>(key: K) => RouterEnv['Variables'][K];
};

type RouterContext = Context<RouterEnv>;

export type { AuthenticatedAccount, RouteContext, RouterContext, RouterEnv };
