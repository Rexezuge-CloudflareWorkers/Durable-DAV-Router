// Shared DAO thunk bundle for service bindings.
import type { RouterBackendDAO, UserDAO } from '@durable-dav-router/backend-data/dao';
import type { RequestScopeEnv } from '../serviceFactory';

interface DaoThunks {
  userDAO: () => Promise<UserDAO>;
  routerBackendDAO: () => Promise<RouterBackendDAO>;
}

interface ServiceGroupContext {
  env: RequestScopeEnv;
  daos: DaoThunks;
}

export type { DaoThunks, ServiceGroupContext };
