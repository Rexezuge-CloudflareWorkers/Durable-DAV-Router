import type { RouterBackendDAO, UserDAO } from '@durable-dav-router/backend-data/dao';
import type { Token } from '@durable-dav-router/backend-runtime/di';
import type { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';
import type { AccessAuthService } from '../auth/AccessAuthService';
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
  RouterBackendDAO: Symbol('RouterBackendDAO') as Token<() => Promise<RouterBackendDAO>>,
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  UserService: Symbol('UserService') as Token<UserService>,
  BackendService: Symbol('BackendService') as Token<BackendService>,
  // `AppConfig` is bound for services that need injected configuration; it is
  // not resolved by handlers (they receive a fully-built service instead).
  AppConfig: Symbol('AppConfig') as Token<AppConfiguration>,
} satisfies Record<string, Token<unknown>>;

export { Tokens };
