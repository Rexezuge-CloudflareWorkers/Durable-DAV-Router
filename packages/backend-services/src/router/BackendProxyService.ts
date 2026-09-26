import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';

const PASSTHROUGH_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'depth',
  'overwrite',
  'destination',
  'range',
  'if',
  'lock-token',
  'timeout',
  'content-length',
  'content-range',
  'accept',
  'accept-language',
  'cache-control',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'cf-access-jwt-assertion',
]);

const PASSTHROUGH_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'dav',
  'allow',
  'etag',
  'last-modified',
  'location',
  'date',
  'content-location',
  'lock-token',
  'www-authenticate',
  'cache-control',
  'expires',
]);

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

function joinBackendUrl(baseUrl: string, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${stripTrailingSlashes(baseUrl)}${normalized}`;
}

function rewriteDestinationForBackend(destination: string | null, routerOrigin: string, backendBaseUrl: string): string | null {
  if (!destination) return null;
  try {
    const destUrl = new URL(destination, routerOrigin);
    // Only rewrite same-router absolute URLs; cross-origin destinations pass through.
    return destUrl.origin === routerOrigin ? joinBackendUrl(backendBaseUrl, `${destUrl.pathname}${destUrl.search}`) : destination;
  } catch {
    return destination;
  }
}

function buildProxiedHeaders(incoming: Request, routerOrigin: string, backendBaseUrl: string): Headers {
  const out = new Headers();
  incoming.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!PASSTHROUGH_REQUEST_HEADERS.has(lower)) return;
    if (lower === 'destination') {
      const rewritten = rewriteDestinationForBackend(value, routerOrigin, backendBaseUrl);
      if (rewritten) out.set('Destination', rewritten);
      return;
    }
    if (lower === 'host' || lower === 'content-length') return;
    out.set(key, value);
  });
  return out;
}

function filterProxiedResponseHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    if (PASSTHROUGH_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

type BackendResolution =
  | { kind: 'single'; backend: RouterBackendRow }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; backends: RouterBackendRow[] };

function resolveBackend(backends: RouterBackendRow[], explicitSlug?: string | null): BackendResolution {
  if (explicitSlug) {
    const match = backends.find((b) => b.slug.toLowerCase() === explicitSlug.toLowerCase());
    return match ? { kind: 'single', backend: match } : { kind: 'not-found' };
  }
  if (backends.length === 0) return { kind: 'not-found' };
  return backends.length === 1 ? { kind: 'single', backend: backends[0] } : { kind: 'ambiguous', backends };
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getProxyTimeoutMs(env: unknown): number {
  try {
    return AppConfiguration.fromEnv(env).getBackendFetchTimeoutMs();
  } catch {
    return 8000;
  }
}

export {
  PASSTHROUGH_REQUEST_HEADERS,
  PASSTHROUGH_RESPONSE_HEADERS,
  joinBackendUrl,
  rewriteDestinationForBackend,
  buildProxiedHeaders,
  filterProxiedResponseHeaders,
  resolveBackend,
  fetchWithTimeout,
  getProxyTimeoutMs,
  stripTrailingSlashes,
  stripSlashes,
};
export type { BackendResolution };
