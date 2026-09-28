import type { Context } from 'hono';
import type { AccountIdentity } from '@durable-dav-router/backend-services/identity';

/**
 * The authenticated caller's account, as recorded on the request by
 * `userAuthenticationHandler`.
 *
 * This replaces the former `AuthenticatedUserEmailAddress: string`. The address
 * Access asserts is an *attribute* of the account, not its identity: keeping only
 * the string meant every owner-scoped query was keyed on a value the user could
 * not change without losing access to everything registered under it. The id is
 * the identity, and it survives an address change.
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

type RouterContext = Context<RouterEnv>;

export type { AuthenticatedAccount, RouterContext, RouterEnv };
