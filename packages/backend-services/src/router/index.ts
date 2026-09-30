export { BackendService, normalizeSlug, normalizeBaseUrl, normalizeDisplayName, isPrivateBackendHostAllowed } from './BackendService';
export { selectBackend, explicitBackendSlug } from './BackendSelection';
export type { BackendServiceEnv, BackendServiceDeps } from './BackendService';
export {
  joinBackendUrl,
  joinBackendUrlWithoutSelector,
  stripBackendSelector,
  describeBackendFailure,
  truncateSnippet,
  rewriteDestinationForBackend,
  buildProxiedHeaders,
  filterProxiedResponseHeaders,
  resolveBackend,
  fetchWithTimeout,
  getProxyTimeoutMs,
  stripTrailingSlashes,
  stripSlashes,
  bodylessMethods,
  BODYLESS_METHODS,
  PASSTHROUGH_REQUEST_HEADERS,
  PASSTHROUGH_RESPONSE_HEADERS,
} from './BackendProxyService';
export type { BackendResolution, RoutableBackend } from './BackendProxyService';
// The *send* half of the proxy: the shared forwarder both DAV-carrying planes use,
// plus the Access-credential passthrough. Split from `BackendProxyService`, which
// is the URL-and-header *shape* half.
export { forwardDavRequest, forwardAuthHeaders, markAsRouterRequest, isTimeoutError, ROUTER_USER_AGENT } from './BackendProxyRequest';
// Volume-existence probing, split out of `BackendProxyService` to keep that
// file under the god-file guard. Re-exported here so callers keep one import.
export {
  buildProbeHeaders,
  VOLUME_PROBE_BODY,
  PROBE_AUTHORIZATION,
  MAX_PROBE_CANDIDATES,
  classifyProbeStatus,
  probeCandidateBackends,
} from './BackendProbe';
export type { AutoResolution, ProbeSignal } from './BackendProbe';
export {
  getCachedRoute,
  putCachedRoute,
  invalidateCachedRoute,
  invalidateCachedRouteIfPresent,
  purgeCachedRoutes,
  parseDestinationVolume,
  routeCacheParts,
  getRouteCacheTtlSeconds,
  isCachedRoute,
  sameRoute,
  clearRouteCacheL1,
} from './RouteCacheService';
export type { CachedRoute } from './RouteCacheService';
