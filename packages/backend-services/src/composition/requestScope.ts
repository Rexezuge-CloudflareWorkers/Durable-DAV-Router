import { Container } from '@durable-dav-router/backend-runtime/di';
import { KvCache } from '@durable-dav-router/backend-runtime/kv';
import type { KvNamespaceLike } from '@durable-dav-router/backend-runtime/kv';
import { Tokens } from './tokens';
import type { RequestScopeEnv } from './serviceFactory';
import { bindDaoBindings } from './daoBindings';
import { bindServiceBindings } from './serviceBindings';

// Composition root: builds a per-request child scope wiring DAOs → services.
// DAO tables live in `daoBindings.ts`, service wiring in
// `serviceBindings.ts`; this module only owns scope lifecycle. The router is
// stateless (D1 + KV `davRoute` lookaside, no DOs): aggregated reads fan out
// live to backends.
function createRequestScope(env: RequestScopeEnv): Container {
  const scope = new Container();
  // Single CACHE binding (absent in tests / legacy deploys → fail-soft cache).
  scope.bindValue(Tokens.KvCache, new KvCache((env as { CACHE?: KvNamespaceLike }).CACHE ?? null));

  bindDaoBindings(scope, env);
  bindServiceBindings(scope, env);

  return scope;
}

export { createRequestScope };
export type { RequestScopeEnv } from './serviceFactory';
