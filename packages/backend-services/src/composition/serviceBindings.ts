// Service bindings for the per-request composition root.
import type { RouterBackendDAO, UserDAO, UserEmailDAO } from '@durable-dav-router/backend-data/dao';
import type { Container, Token } from '@durable-dav-router/backend-runtime/di';
import { Tokens } from './tokens';
import type { RequestScopeEnv } from './serviceFactory';
import type { DaoThunks } from './serviceBindings/daoThunks';
import { bindCoreServices } from './serviceBindings/coreServices';

function bindServiceBindings(scope: Container, env: RequestScopeEnv): void {
  const getDao = <T>(token: Token<() => Promise<T>>): (() => Promise<T>) => scope.get(token);

  const daos: DaoThunks = {
    userDAO: getDao<UserDAO>(Tokens.UserDAO),
    userEmailDAO: getDao<UserEmailDAO>(Tokens.UserEmailDAO),
    routerBackendDAO: getDao<RouterBackendDAO>(Tokens.RouterBackendDAO),
  };

  bindCoreServices(scope, { env, daos });
}

export { bindServiceBindings };
