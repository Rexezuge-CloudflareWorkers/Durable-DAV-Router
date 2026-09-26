export { BackendService, normalizeSlug, normalizeBaseUrl } from './BackendService';
export type { BackendServiceEnv, BackendServiceDeps } from './BackendService';
export {
  joinBackendUrl,
  rewriteDestinationForBackend,
  buildProxiedHeaders,
  filterProxiedResponseHeaders,
  resolveBackend,
  fetchWithTimeout,
  getProxyTimeoutMs,
  stripTrailingSlashes,
  stripSlashes,
} from './BackendProxyService';
export type { BackendResolution } from './BackendProxyService';
