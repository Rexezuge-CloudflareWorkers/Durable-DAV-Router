const DAV_CLASS = '1, 2';

const SUPPORT_METHODS = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'DELETE', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'];

const CORS_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'depth',
  'overwrite',
  'destination',
  'range',
  'if',
  'lock-token',
  'timeout',
].join(', ');

const CORS_EXPOSE_HEADERS = [
  'content-type',
  'content-length',
  'dav',
  'etag',
  'last-modified',
  'location',
  'date',
  'content-range',
  'lock-token',
  // Browsers cannot read the Basic challenge without this, so a client cannot
  // distinguish "wrong password" from "volume does not exist".
  'www-authenticate',
].join(', ');

/**
 * Origins permitted to drive cross-origin WebDAV traffic through the router.
 *
 * Previously any `Origin` was reflected verbatim. `Access-Control-Allow-
 * Credentials: false` blocks cross-origin *reads* of a credentialed response,
 * but it does nothing about writes: the preflight still succeeds, so a page on
 * any origin could issue `PUT`/`DELETE`/`MKCOL` against a bucket, and the
 * router forwards `Cookie` verbatim — a backend session cookie would be
 * replayed on those requests.
 *
 * An empty allow-list means "same-origin only": the SPA is served from this
 * same origin, so browsers never need a cross-origin grant to use it, and
 * WebDAV clients are not browsers. Deployments that genuinely need a
 * cross-origin Web UI must opt in explicitly.
 */
const DEFAULT_CORS_ALLOWED_ORIGINS: readonly string[] = [];

/**
Cache of parsed allow-lists, keyed by the raw comma-separated env value.
*/
const allowedOriginCache = new Map<string, ReadonlySet<string>>();

function parseAllowedOrigins(raw = ''): ReadonlySet<string> {
  const cached = allowedOriginCache.get(raw);
  if (cached) return cached;
  const parsed = new Set(
    raw
      .split(',')
      .map((origin) => origin.trim().toLowerCase())
      .filter((origin) => origin.length > 0),
  );
  // Bound the cache so distinct values cannot grow it without limit; the set of
  // configurations an isolate sees is small in practice.
  if (allowedOriginCache.size > 32) allowedOriginCache.clear();
  allowedOriginCache.set(raw, parsed);
  return parsed;
}

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request.
 *
 * Returns `null` when the origin is not allow-listed, which the caller must
 * treat as "send no CORS headers at all" — omitting the header is what makes
 * the browser refuse the response, which is the intended outcome.
 *
 * `allowListRaw` is `undefined` when no allow-list was configured at all, and
 * `null` when one was configured and the request origin is absent. The
 * distinction matters: the first falls back to the compile-time default, the
 * second has no origin to grant.
 */
function resolveAllowedOrigin(requestOrigin: string | null, allowListRaw?: string | null): string | null {
  if (!requestOrigin || requestOrigin === 'null') return null;
  if (allowListRaw === undefined) {
    return DEFAULT_CORS_ALLOWED_ORIGINS.includes(requestOrigin.toLowerCase()) ? requestOrigin : null;
  }
  const allowed = parseAllowedOrigins(allowListRaw ?? '');
  if (!allowed.has('*')) {
    return allowed.has(requestOrigin.toLowerCase()) ? requestOrigin : null;
  }
  // A literal `*` opts back into the permissive behavior, but still must not be
  // combined with credentialed access, so no origin is echoed.
  return '*';
}

function applyCors(response: Response, request: Request, allowListRaw?: string | null): Response {
  // DO RPC responses arrive with immutable headers — rebuild instead of mutating.
  const headers = new Headers(response.headers);
  const requestOrigin = request.headers.get('Origin');
  const allowed = resolveAllowedOrigin(requestOrigin, allowListRaw);
  if (allowed !== null) {
    headers.set('Access-Control-Allow-Origin', allowed);
  }
  // `Vary: Origin` is mandatory whenever the response depends on the request
  // origin, otherwise a shared cache can serve one origin's grant to another.
  headers.append('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
  headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
  headers.set('Access-Control-Allow-Credentials', 'false');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function createdResponse(resourceHref: string, body: BodyInit | null = '', headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Location', resourceHref);
  return new Response(body, { status: 201, headers: responseHeaders });
}

export {
  DAV_CLASS,
  SUPPORT_METHODS,
  CORS_ALLOW_HEADERS,
  CORS_EXPOSE_HEADERS,
  DEFAULT_CORS_ALLOWED_ORIGINS,
  applyCors,
  createdResponse,
  parseAllowedOrigins,
  resolveAllowedOrigin,
};
