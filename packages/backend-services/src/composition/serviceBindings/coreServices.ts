// Identity + router bindings: auth, users, backends.
import { AccessAuthService } from '@durable-dav-router/backend-services/auth';
import { BackendService } from '@durable-dav-router/backend-services/router';
import { UserService } from '@durable-dav-router/backend-services/user';
import type { Container } from '@durable-dav-router/backend-runtime/di';
import { Tokens } from '../tokens';
import { createService } from '../serviceFactory';
import type { ServiceGroupContext } from './daoThunks';

function bindCoreServices(scope: Container, { env, daos }: ServiceGroupContext): void {
  scope.bind(Tokens.AccessAuthService, () => createService(AccessAuthService, env));
  scope.bind(Tokens.UserService, () =>
    createService(UserService, env, {
      userDAO: daos.userDAO,
    }),
  );
  scope.bind(Tokens.BackendService, () =>
    createService(BackendService, env, {
      backendDAO: daos.routerBackendDAO,
    }),
  );
}

export { bindCoreServices };
