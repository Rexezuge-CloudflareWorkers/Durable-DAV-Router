import { Container } from '@durable-dav-router/backend-runtime/di';
import { Tokens } from './tokens';
import type { RequestScopeEnv } from './serviceFactory';
import { bindDaoBindings } from './daoBindings';
import { bindServiceBindings } from './serviceBindings';

// Composition root: builds a per-request child scope wiring DAOs → services.
// DAO tables live in `daoBindings.ts`, service wiring in
// `serviceBindings.ts`; this module only owns scope lifecycle. The router is
// stateless (no KV cache, no DOs): aggregated reads fan out live to backends.
function createRequestScope(env: RequestScopeEnv): Container {
  const scope = new Container();
  scope.bindValue(Tokens.Env, env);
  scope.bindValue(Tokens.Db, env.DB);

  bindDaoBindings(scope, env);
  bindServiceBindings(scope, env);

  return scope;
}

export { createRequestScope };
export type { RequestScopeEnv } from './serviceFactory';
