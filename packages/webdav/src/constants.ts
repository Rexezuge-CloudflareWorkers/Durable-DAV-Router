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
 * distinction matters: the first is "same-origin only", the second has no
 * origin to grant.
 *
 * Same-origin-only is a decision, not a default awaiting a wider one. Previously
 * any `Origin` was reflected verbatim, and `Access-Control-Allow-Credentials:
 * false` blocks cross-origin *reads* of a credentialed response while doing
 * nothing about writes — so the preflight still succeeded and a page on any
 * origin could issue `PUT`/`DELETE`/`MKCOL` against a bucket with the `Cookie`
 * header forwarded verbatim. The shipped SPA is served from this origin, so it
 * never needs a cross-origin grant, and WebDAV clients are not browsers. A
 * deployment that genuinely needs a cross-origin Web UI passes an explicit list,
 * or `*`.
 */
function resolveAllowedOrigin(requestOrigin: string | null, allowListRaw?: string | null): string | null {
  if (!requestOrigin || requestOrigin === 'null' || (allowListRaw === undefined)) return null;
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

export { SUPPORT_METHODS, applyCors };
