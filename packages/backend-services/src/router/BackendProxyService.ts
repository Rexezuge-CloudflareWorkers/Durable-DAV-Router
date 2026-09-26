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
  'cookie',
  'user-agent',
  'translate',
  'brief',
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
  'ms-author-via',
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
    // Strip the router `?backend=` selector so it never leaks to the backend.
    return destUrl.origin === routerOrigin ? joinBackendUrlWithoutSelector(backendBaseUrl, destUrl.pathname, destUrl.search) : destination;
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

function stripBackendSelector(search: string): string {
  if (!search) return '';
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.delete('backend');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

function joinBackendUrlWithoutSelector(baseUrl: string, pathname: string, search: string): string {
  return joinBackendUrl(baseUrl, `${pathname}${stripBackendSelector(search)}`);
}

// Volume-existence probe for ambiguous owner routing. Native clients send a
// bare `/:owner/:volume` URL with no `?backend=` hint, so when one owner maps
// to several backends the router probes each candidate's volume root with
// `PROPFIND Depth: 0` (forwarding the caller's auth) and routes to the unique
// owner. Probes target the volume root — not the full inner path — so file
// creation inside an existing volume still resolves.
const VOLUME_PROBE_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><propname/></propfind>';

type ProbeSignal = 'hit' | 'auth' | 'miss' | 'unknown';

const PROBE_HIT_STATUSES = new Set([207, 301, 302, 303, 307, 308]);
const PROBE_AUTH_STATUSES = new Set([401, 403, 423]);
const PROBE_MISS_STATUSES = new Set([404, 410]);

function classifyProbeStatus(status: number): ProbeSignal {
  if (PROBE_MISS_STATUSES.has(status)) return 'miss';
  if (PROBE_AUTH_STATUSES.has(status)) return 'auth';
  return PROBE_HIT_STATUSES.has(status) || (status >= 200 && status < 300) ? 'hit' : 'unknown';
}

type AutoResolution =
  | { kind: 'single'; backend: RouterBackendRow }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; backends: RouterBackendRow[] }
  | { kind: 'unavailable' };

interface ProbeCandidatesInput {
  candidates: RouterBackendRow[];
  volumePath: string;
  incoming: Request;
  routerOrigin: string;
  timeoutMs: number;
}

async function probeCandidateBackends(input: ProbeCandidatesInput): Promise<AutoResolution> {
  const settled = await Promise.allSettled(
    input.candidates.map(async (backend) => {
      const target = joinBackendUrl(backend.base_url, input.volumePath);
      const headers = buildProxiedHeaders(input.incoming, input.routerOrigin, backend.base_url);
      headers.set('Depth', '0');
      headers.set('Content-Type', 'application/xml');
      const res = await fetchWithTimeout(
        new Request(target),
        { method: 'PROPFIND', headers, redirect: 'manual', body: VOLUME_PROBE_BODY },
        input.timeoutMs,
      );
      // Drain so workers can reuse the connection; status is all we keep.
      await res.arrayBuffer().catch(() => undefined);
      return { backend, signal: classifyProbeStatus(res.status) };
    }),
  );
  const hits: RouterBackendRow[] = [];
  const authHits: RouterBackendRow[] = [];
  let unknown = 0;
  const probed = settled.map((r) =>
    r.status === 'fulfilled' ? r.value : { backend: null, signal: 'unknown' as ProbeSignal },
  );
  for (const p of probed) {
    if (p.signal === 'hit' && p.backend !== null) hits.push(p.backend);
    if (p.signal === 'auth' && p.backend !== null) authHits.push(p.backend);
    if (p.signal === 'unknown') unknown += 1;
  }
  if (hits.length === 1) return { kind: 'single', backend: hits[0] };
  if (hits.length > 1) return { kind: 'ambiguous', backends: hits };
  // No strong hit: a lone auth-gated candidate still owns the volume — route
  // there so the caller gets the backend's real 401/403 verbatim.
  if (authHits.length === 1) return { kind: 'single', backend: authHits[0] };
  if (authHits.length > 1) return { kind: 'ambiguous', backends: authHits };
  return ({ kind: unknown > 0 ? 'unavailable' : 'not-found' });
}

function truncateSnippet(value: string, max = 200): string {
  const flat = value.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeBackendFailure(status: number, bodySnippet: string): string {
  const snippet = bodySnippet ? ` — ${truncateSnippet(bodySnippet)}` : '';
  if (status >= 520 && status <= 527) {
    return (
      `backend responded ${status} (Cloudflare could not reach the backend origin; ` +
      `verify baseUrl DNS/TLS, backend deployment is running, and Access/firewall allows Worker egress)${snippet}`
    );
  }
  if ([301, 302, 303, 307, 308].includes(status)) {
    return (
      `backend responded ${status} (redirect — often a Cloudflare Access login redirect; ` +
      `check backend Access policy and forwarded Cf-Access-Jwt-Assertion/Cookie)${snippet}`
    );
  }
  return status === 401 || status === 403 ? (
      `backend responded ${status} (backend rejected router credentials; ` +
      `check Access JWT audience and forwarded Authorization/Cookie)${snippet}`
    ) : `backend responded ${status}${snippet}`;
}

export {
  PASSTHROUGH_REQUEST_HEADERS,
  PASSTHROUGH_RESPONSE_HEADERS,
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
  VOLUME_PROBE_BODY,
  classifyProbeStatus,
  probeCandidateBackends,
};
export type { BackendResolution, AutoResolution, ProbeSignal };
