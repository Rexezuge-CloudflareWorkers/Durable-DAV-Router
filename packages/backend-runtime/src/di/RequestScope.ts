import type { Container } from './Container';
import type { ServiceEnv } from '../config/ServiceEnv';

/**
 * Memoized async factory helper for the composition root.
 * Replaces hand-rolled `let pending; return () => (pending ??= fn())`
 * closures scattered across `requestScope.ts`.
 *
 * Rejections are never cached: a transient D1/KV failure must not poison the
 * whole request scope — the next call retries.
 */
function memoizeAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = fn();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

/**
 * Single-scope-per-request helper (Otter pattern).
 * Middleware creates one `Container` per request and stores it on the Hono
 * context; handlers resolve via `getRequestScope(c)` instead of calling
 * `createRequestScope(c.env)` per handler (which minted N scopes per request
 * and broke singleton memoization).
 */
interface ScopedContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  readonly env: ServiceEnv;
}

// Namespaced to this project: the key is a property on a shared context
// object, so a collision with a host application would silently return the
// wrong scope.
const SCOPE_KEY = '__durableDavRouterScope';

function setRequestScope(c: ScopedContext, scope: Container): void {
  c.set(SCOPE_KEY, scope);
}

/**
 * Structural adapter for Hono contexts.
 * Hono's `Context.get` overloads are not assignable to `ScopedContext['get']`,
 * so a cast is unavoidable somewhere. This holds the one the *scope* needs.
 *
 * It does not hold the casts in `apps/api`'s route modules, which come from a
 * different mismatch — `BaseRoute`'s statics are typed against the full Hono
 * `Context` while the route helpers call them with a narrowed structural type —
 * and which are removed in the change that gives those helpers one declared
 * context type of their own.
 */
function asScopedContext(c: { get(key: string): unknown; set?(key: string, value: unknown): void; readonly env: unknown }): ScopedContext {
  return c as unknown as ScopedContext;
}

function getRequestScope(c: ScopedContext): Container {
  const scope = c.get(SCOPE_KEY) as Container | undefined;
  if (!scope) throw new Error('Request scope is not set. Register scopeMiddleware before routes.');
  return scope;
}

export { memoizeAsync, setRequestScope, getRequestScope, asScopedContext, SCOPE_KEY };
export type { ScopedContext };
