import type { RouterBackendDAO, UserDAO, UserEmailDAO } from '@durable-dav-router/backend-data/dao';
import type { Token } from '@durable-dav-router/backend-runtime/di';
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';
import type { AccessAuthService } from '../auth/AccessAuthService';
import type { UserIdentityService } from '../identity/UserIdentityService';
import type { UserService } from '../user/UserService';
import type { BackendService } from '../router/BackendService';

// Central token registry for the per-request composition root
// (`requestScope.ts`). Call sites resolve services via
// `scope.get(Tokens.BackendService)` instead of `new X(env)`.
//
// Tokens carry their value type (`Token<T>`) so `scope.get(...)` infers the
// service type without an explicit generic at call sites.
const Tokens = {
  KvCache: Symbol('KvCache') as Token<KvCache>,
  UserDAO: Symbol('UserDAO') as Token<() => Promise<UserDAO>>,
  UserEmailDAO: Symbol('UserEmailDAO') as Token<() => Promise<UserEmailDAO>>,
  RouterBackendDAO: Symbol('RouterBackendDAO') as Token<() => Promise<RouterBackendDAO>>,
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  // One memoized address→account resolver per request scope, so the auth
  // middleware and every route that reads the caller's backends share a single
  // registry lookup.
  UserIdentityService: Symbol('UserIdentityService') as Token<UserIdentityService>,
  UserService: Symbol('UserService') as Token<UserService>,
  BackendService: Symbol('BackendService') as Token<BackendService>,
} satisfies Record<string, Token<unknown>>;

export { Tokens };
