import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';

// Request headers forwarded verbatim to the backend. `content-length` is
// deliberately absent: the runtime recomputes it from the stream we hand it,
// and copying the inbound value desynchronizes it whenever the body is
// re-encoded. `host` is absent because the backend origin must be used.
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

// Response headers forwarded back to the client. `content-length` is excluded
// for the same reason as on the request side, and `content-encoding` is
// excluded because forwarding a body without its encoding header (or vice
// versa) yields a truncated or corrupt response.
const PASSTHROUGH_RESPONSE_HEADERS = new Set([
  'content-type',
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
  // Paged-listing metadata, on a `207` from a backend that pages
  // `Depth: 1`. Load-bearing rather than cosmetic: without these the SPA reads
  // the response as *unpaged* and slices the whole body itself, which silently
  // defeats the paging rather than failing loudly. A backend that does not
  // implement paging simply omits them, which is the version-skew fallback.
  'x-dav-page',
  'x-dav-page-limit',
  'x-dav-page-count',
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
  { kind: 'single'; backend: RouterBackendRow } | { kind: 'not-found' } | { kind: 'ambiguous'; backends: RouterBackendRow[] };

function resolveBackend(backends: RouterBackendRow[], explicitSlug?: string | null): BackendResolution {
  // Trim before testing for presence: a whitespace-only selector is an absent
  // one, and treating it as a slug would answer 404 for a request that should
  // have been resolved by probing.
  const explicit = typeof explicitSlug === 'string' ? explicitSlug.trim() : '';
  if (explicit) {
    const match = backends.find((b) => b.slug.toLowerCase() === explicit.toLowerCase());
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
  // Surgical removal rather than a `URLSearchParams` round trip. Re-encoding
  // would reorder parameters and normalize `%20` to `+`, which silently
  // mangles signature-bearing query strings (Cloudflare Access signed URLs,
  // S3/R2 presigned URLs) that a backend may require.
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const kept = raw.split('&').filter((pair) => pair.length > 0 && !/^backend=/i.test(pair) && pair.toLowerCase() !== 'backend');
  return kept.length > 0 ? `?${kept.join('&')}` : '';
}

function joinBackendUrlWithoutSelector(baseUrl: string, pathname: string, search: string): string {
  return joinBackendUrl(baseUrl, `${pathname}${stripBackendSelector(search)}`);
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
  return status === 401 || status === 403
    ? `backend responded ${status} (backend rejected router credentials; ` +
        `check Access JWT audience and forwarded Authorization/Cookie)${snippet}`
    : `backend responded ${status}${snippet}`;
}

/**
 * Forward a DAV-semantics request to a backend and stream the answer back.
 *
 * Shared by both DAV-carrying planes (`/:owner/:volume/*` and the browser plane's
 * `/user/volumes/:owner/:volume/*`) so they cannot drift on the parts that are
 * load-bearing: the streamed request body, the streamed response body, and the
 * timeout → 504 vs unreachable → 502 distinction. `forwardToBackend` in
 * `apps/api` still exists for the JSON management paths, which buffer
 * `res.text()` by design and must not be routed here.
 *
 * `headers` is the caller's to build, because the two planes disagree on
 * `User-Agent`: the WebDAV plane forwards the client's own, while the browser
 * plane pins the router's marker so a backend can still tell a proxied request
 * from a direct one.
 */
/**
 * Methods that never carry a request body.
 *
 * One definition for both proxy planes. `OPTIONS` belongs here because it is a
 * `SUPPORT_METHODS` member and a capability probe — the JSON management forwarder
 * in `apps/api` carried a two-element copy of this set that omitted it, and two
 * implementations of one question is how the copies drift.
 */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function bodylessMethods(): ReadonlySet<string> {
  return BODYLESS_METHODS;
}

async function forwardDavRequest(request: Request, target: string, headers: Headers, timeoutMs: number): Promise<Response> {
  const method = request.method;
  const hasBody = !BODYLESS_METHODS.has(method);
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      new Request(target),
      {
        method,
        headers,
        redirect: 'manual',
        body: hasBody ? request.body : undefined,
        ...(hasBody && { duplex: 'half' }),
      },
      timeoutMs,
    );
  } catch (error) {
    // A timeout is a 504, not a 502: the origin did not answer within the
    // budget, which is a distinct condition clients retry differently. Log the
    // cause — a silent catch here is the only signal an unreachable backend
    // produces.
    const isTimeout = error instanceof Error && (error.name === 'AbortError' || /aborted|timeout/i.test(error.message));
    const targetUrl = safeUrl(target);
    console.warn(
      `backend ${targetUrl.origin} ${isTimeout ? `timed out after ${timeoutMs}ms` : 'unreachable'} for ${method} ${targetUrl.pathname}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Response(isTimeout ? 'Backend timed out' : 'Backend unreachable', { status: isTimeout ? 504 : 502 });
  }
  return new Response(upstream.body, { status: upstream.status, headers: filterProxiedResponseHeaders(upstream.headers) });
}

/**
`new URL` for log output, where a malformed base must not throw.
*/
function safeUrl(target: string): { origin: string; pathname: string } {
  try {
    const parsed = new URL(target);
    return { origin: parsed.origin, pathname: parsed.pathname };
  } catch {
    return { origin: 'unknown', pathname: target };
  }
}

export {
  BODYLESS_METHODS,
  bodylessMethods,
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
  forwardDavRequest,
  resolveBackend,
  fetchWithTimeout,
  getProxyTimeoutMs,
  stripTrailingSlashes,
  stripSlashes,
};
export type { BackendResolution };
