/**
 * Forwarding a request to a backend.
 *
 * Split from `BackendProxyService`, which is the *shape* half — URL joins,
 * header allow-lists, selector matching. This is the *send* half: the shared
 * forwarder both DAV-carrying planes use, so the streamed request body, the
 * streamed response body, and the timeout → 504 vs unreachable → 502 distinction
 * cannot drift between them.
 *
 * The two planes still differ on one thing, and `forwardDavRequest` takes headers
 * rather than building them so that difference costs one line rather than a
 * second copy of the fetch: the WebDAV plane forwards the caller's own
 * `User-Agent`, while the browser plane pins the router's marker so a backend can
 * still tell a proxied request from a direct one.
 */
import { BODYLESS_METHODS, fetchWithTimeout, filterProxiedResponseHeaders, safeUrl } from './BackendProxyService';

/**
Marks a proxied request as router-originated in backend logs.
*/
const ROUTER_USER_AGENT = 'durable-dav-router';

/**
 * The caller's Cloudflare Access credentials, forwarded verbatim.
 *
 * Verbatim because the router stores no credentials of its own: a backend
 * validates the assertion against its own Access application. The router's own
 * marker headers are *not* set here — a liveness probe and an identity lookup are
 * told apart by whether the caller asked for them, so `markAsRouterRequest` is a
 * separate, explicit step.
 *
 * One definition. The JSON management plane, the liveness probe and the
 * per-backend identity lookup each had a copy, and the three had already drifted
 * on which half set `Accept`/`User-Agent`.
 */
function forwardAuthHeaders(request: Request): Headers {
  const out = new Headers();
  // Headers are case-insensitive, so the second lookup only matters for a
  // `Request`-like object that is not one — which the route tests' doubles are.
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ?? request.headers.get('cf-access-jwt-assertion');
  if (jwt) out.set('Cf-Access-Jwt-Assertion', jwt);
  const auth = request.headers.get('Authorization');
  if (auth) out.set('Authorization', auth);
  const cookie = request.headers.get('Cookie');
  if (cookie) out.set('Cookie', cookie);
  return out;
}

/**
 * Mark a request as a router-originated API call in backend logs.
 *
 * Separate from `forwardAuthHeaders` because a probe wants the router's marker and
 * no caller credentials at all, and the DAV planes want the *caller's*
 * `User-Agent` preserved instead.
 */
function markAsRouterRequest(headers: Headers): Headers {
  headers.set('Accept', 'application/json');
  headers.set('User-Agent', ROUTER_USER_AGENT);
  return headers;
}

/**
 * Whether a thrown value from `fetch` means "the origin did not answer in time"
 * rather than "the origin could not be reached".
 *
 * A timeout is a 504 and an unreachable origin a 502: they are distinct
 * conditions that clients retry differently, and the distinction is invisible in
 * a test that only ever produces one of them. `AbortController` names the failure
 * `AbortError`, but a Workers `fetch` can also report a deadline as an ordinary
 * `TypeError`, so the message is checked too.
 *
 * One definition because four call sites had four copies, and one of them had
 * already dropped the `instanceof Error` guard the other three kept.
 */
function isTimeoutError(error: unknown): boolean {
  // Two named locals rather than one compound expression: `a || b && c` needs a
  // reader to re-derive the precedence, which is the only thing this is for.
  if (!(error instanceof Error)) return false;
  const byName = error.name === 'AbortError';
  const byMessage = /aborted|timeout/i.test(error.message);
  return byName || byMessage;
}

/**
 * Send a DAV-semantics request to a backend and stream the answer back.
 *
 * `apps/api`'s JSON management forwarder deliberately does not use this: it
 * buffers `res.text()` by design, because those payloads are small JSON documents
 * rather than file bytes, and `res.text()` on a stream is what corrupts a binary
 * download.
 */
async function forwardDavRequest(request: Request, target: string, headers: Headers, timeoutMs: number): Promise<Response> {
  const hasBody = !BODYLESS_METHODS.has(request.method);
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      new Request(target),
      {
        method: request.method,
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
    const isTimeout = isTimeoutError(error);
    const url = safeUrl(target);
    console.warn(
      `backend ${url.origin} ${isTimeout ? `timed out after ${timeoutMs}ms` : 'unreachable'} for ${request.method} ${url.pathname}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Response(isTimeout ? 'Backend timed out' : 'Backend unreachable', { status: isTimeout ? 504 : 502 });
  }
  return new Response(upstream.body, { status: upstream.status, headers: filterProxiedResponseHeaders(upstream.headers) });
}

export { forwardDavRequest, forwardAuthHeaders, markAsRouterRequest, isTimeoutError, ROUTER_USER_AGENT };
