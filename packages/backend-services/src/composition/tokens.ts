import type { NamespaceDAO, RouterBackendDAO, UserDAO } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';
import type { Token } from '@durable-dav-router/backend-runtime/di';
import type { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import type { AccessAuthService } from '../auth/AccessAuthService';
import type { UserService } from '../user/UserService';
import type { BackendService } from '../router/BackendService';

// Central token registry for the per-request composition root
// (`requestScope.ts`). Call sites resolve services via
// `scope.get(Tokens.BackendService)` instead of `new X(env)`.
//
// Tokens carry their value type (`Token<T>`) so `scope.get(...)` infers the
// service type without an explicit generic at call sites.
interface RequestScopeEnvShape {
  DB: D1Queryable;
}

const Tokens = {
  Env: Symbol('Env') as Token<RequestScopeEnvShape>,
  Db: Symbol('Db') as Token<D1Queryable>,
  AppConfig: Symbol('AppConfig') as Token<AppConfiguration>,
  UserDAO: Symbol('UserDAO') as Token<() => Promise<UserDAO>>,
  NamespaceDAO: Symbol('NamespaceDAO') as Token<() => Promise<NamespaceDAO>>,
  RouterBackendDAO: Symbol('RouterBackendDAO') as Token<() => Promise<RouterBackendDAO>>,
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  UserService: Symbol('UserService') as Token<UserService>,
  BackendService: Symbol('BackendService') as Token<BackendService>,
} satisfies Record<string, Token<unknown>>;

export { Tokens };
