import { Tokens } from '@durable-dav-router/backend-services/composition';
import type { BackendService } from '@durable-dav-router/backend-services/router';
import type { KvCache } from '@durable-dav-router/backend-runtime/kv';
import type { Container } from '@durable-dav-router/backend-runtime/di';

/**
 * Resolving the two things every route reaches for out of the request scope.
 *
 * Both planes needed these and each declared its own copy. `resolveKvCache` was
 * character-for-character identical in `RouterDavProxyRoutes` and
 * `AggregatedVolumeRoutes`, which is how a one-character difference in a
 * fail-soft path survives review of both files.
 */
type Scope = Container;

/**
 * The `davRoute` KV binding, or `null` when the deployment has none.
 *
 * Null is a supported deployment: the router then re-probes on every request
 * instead of reading a cache, which costs egress rather than correctness. The
 * `try` is for a scope built without the binding, not for a KV fault — a KV
 * error is handled inside `KvCache`, which already fails soft.
 */
function resolveKvCache(scope: Scope): KvCache | null {
  try {
    return scope.get(Tokens.KvCache);
  } catch {
    return null;
  }
}

/**
 * The one `BackendService` for this request.
 *
 * A single memoized instance, so the caller's backend list is read once per
 * request rather than once per route.
 */
function resolveBackendService(scope: Scope): BackendService {
  return scope.get(Tokens.BackendService);
}

export { resolveKvCache, resolveBackendService };
