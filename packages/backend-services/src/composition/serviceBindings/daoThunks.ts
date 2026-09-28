// Shared DAO thunk bundle for service bindings.
import type { RouterBackendDAO, UserDAO, UserEmailDAO } from '@durable-dav-router/backend-data/dao';
import type { RequestScopeEnv } from '../serviceFactory';

interface DaoThunks {
  userDAO: () => Promise<UserDAO>;
  userEmailDAO: () => Promise<UserEmailDAO>;
  routerBackendDAO: () => Promise<RouterBackendDAO>;
}

interface ServiceGroupContext {
  env: RequestScopeEnv;
  daos: DaoThunks;
}

export type { DaoThunks, ServiceGroupContext };
