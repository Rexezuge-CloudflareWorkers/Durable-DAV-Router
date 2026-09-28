// Identity + router bindings: auth, users, backends.
import { AccessAuthService } from '@durable-dav-router/backend-services/auth';
import { UserIdentityService } from '@durable-dav-router/backend-services/identity';
import { BackendService } from '@durable-dav-router/backend-services/router';
import { UserService } from '@durable-dav-router/backend-services/user';
import type { Container } from '@durable-dav-router/backend-runtime/di';
import { Tokens } from '../tokens';
import { createService } from '../serviceFactory';
import type { ServiceGroupContext } from './daoThunks';

function bindCoreServices(scope: Container, { env, daos }: ServiceGroupContext): void {
  scope.bind(Tokens.AccessAuthService, () => createService(AccessAuthService, env));
  // Bound before its dependents: address → account resolution is the entry point
  // for every id-keyed ownership check, and its memo is per request scope, so a
  // second instance would re-query the registry for the same caller.
  scope.bind(Tokens.UserIdentityService, () =>
    createService(UserIdentityService, env, {
      userDAO: daos.userDAO,
      userEmailDAO: daos.userEmailDAO,
    }),
  );
  scope.bind(Tokens.UserService, () =>
    createService(UserService, env, {
      userIdentity: () => Promise.resolve(scope.get(Tokens.UserIdentityService)),
    }),
  );
  scope.bind(Tokens.BackendService, () =>
    createService(BackendService, env, {
      backendDAO: daos.routerBackendDAO,
    }),
  );
}

export { bindCoreServices };
