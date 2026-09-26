import { RouterBackendDAO, UserDAO } from '@durable-dav-router/backend-data/dao';
import { Container, memoizeAsync } from '@durable-dav-router/backend-runtime/di';
import type { Token } from '@durable-dav-router/backend-runtime/di';
import { Tokens } from './tokens';
import type { RequestScopeEnv } from './serviceFactory';

// Table-driven DAO wiring. Each entry is keyed by its typed `Tokens.X`
// symbol directly — no stringly-typed lookup table. Each factory thunk is
// lazy + memoized via `memoizeAsync` so `createRequestScope` never touches a
// DAO constructor eagerly: only the DAOs a request actually resolves are
// built.
function bindDaoBindings(scope: Container, env: RequestScopeEnv): void {
  const daoDefs: Array<[Token<() => Promise<unknown>>, () => Promise<unknown>]> = [
    [Tokens.UserDAO, () => Promise.resolve(new UserDAO(env.DB))],
    [Tokens.RouterBackendDAO, () => Promise.resolve(new RouterBackendDAO(env.DB))],
  ];
  for (const [token, create] of daoDefs) {
    scope.bindValue(token, memoizeAsync(create));
  }
}

export { bindDaoBindings };
