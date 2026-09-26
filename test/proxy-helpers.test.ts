import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  stripSlashes,
  stripTrailingSlashes,
  joinBackendUrl,
  stripBackendSelector,
  buildProxiedHeaders,
  buildProbeHeaders,
  filterProxiedResponseHeaders,
  rewriteDestinationForBackend,
  resolveBackend,
  fetchWithTimeout,
  getProxyTimeoutMs,
  truncateSnippet,
  describeBackendFailure,
  probeCandidateBackends,
  PROBE_AUTHORIZATION,
  MAX_PROBE_CANDIDATES,
  PASSTHROUGH_REQUEST_HEADERS,
  PASSTHROUGH_RESPONSE_HEADERS,
} from '@durable-dav-router/backend-services/router';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';

afterEach(() => vi.restoreAllMocks());

const backend = (id: string, baseUrl: string, slug = `s${id}`): RouterBackendRow => ({
  id,
  owner_email: 'u@example.com',
  slug,
  slug_ci: slug.toLowerCase(),
  base_url: baseUrl,
  display_name: null,
  created_at: 1,
  updated_at: 1,
  last_seen_at: null,
  last_status: null,
  backend_username: null,
  backend_username_ci: null,
});

describe('slash normalization', () => {
  it('strips trailing slashes only', () => {
    expect(stripTrailingSlashes('https://x.com///')).toBe('https://x.com');
    expect(stripTrailingSlashes('https://x.com')).toBe('https://x.com');
    expect(stripTrailingSlashes('/')).toBe('');
    expect(stripTrailingSlashes('')).toBe('');
  });

  it('strips leading and trailing slashes from a path', () => {
    // Only the edges: an interior run may be a real empty path segment, and
    // collapsing it would change which resource the client addressed.
    expect(stripSlashes('/a/b/')).toBe('a/b');
    expect(stripSlashes('///a/b///')).toBe('a/b');
    expect(stripSlashes('/a//b/')).toBe('a//b');
    expect(stripSlashes('/')).toBe('');
    expect(stripSlashes('')).toBe('');
  });
});

describe('joinBackendUrl', () => {
  it('joins an origin and a path', () => {
    expect(joinBackendUrl('https://b.com', '/user/volumes')).toBe('https://b.com/user/volumes');
  });

  it('tolerates a missing leading slash and a trailing slash on the base', () => {
    expect(joinBackendUrl('https://b.com/', 'user/volumes')).toBe('https://b.com/user/volumes');
  });

  it('preserves a percent-encoded path verbatim', () => {
    expect(joinBackendUrl('https://b.com', '/a%20b/c')).toBe('https://b.com/a%20b/c');
  });
});

describe('stripBackendSelector', () => {
  it('removes the selector and nothing else', () => {
    expect(stripBackendSelector('?backend=office')).toBe('');
    expect(stripBackendSelector('?backend=office&foo=1')).toBe('?foo=1');
    expect(stripBackendSelector('?foo=1&backend=office')).toBe('?foo=1');
  });

  it('preserves the query byte-for-byte otherwise', () => {
    // A `URLSearchParams` round trip reorders parameters and turns `%20` into
    // `+`, which silently breaks a signature-bearing query (Access signed URLs,
    // S3 presigned URLs) that the backend verifies.
    expect(stripBackendSelector('?b=2&a=1')).toBe('?b=2&a=1');
    expect(stripBackendSelector('?q=hello%20world')).toBe('?q=hello%20world');
    expect(stripBackendSelector('?sig=a%2Bb%3D')).toBe('?sig=a%2Bb%3D');
    expect(stripBackendSelector('?flag')).toBe('?flag');
  });

  it('removes a repeated selector', () => {
    expect(stripBackendSelector('?backend=a&backend=b&x=1')).toBe('?x=1');
  });

  it('handles an empty or absent query', () => {
    expect(stripBackendSelector('')).toBe('');
    expect(stripBackendSelector('?')).toBe('');
    expect(stripBackendSelector('?&&')).toBe('');
  });

  it('is case-insensitive on the parameter name', () => {
    expect(stripBackendSelector('?Backend=office&x=1')).toBe('?x=1');
  });
});

describe('buildProxiedHeaders', () => {
  const req = (headers: Record<string, string>) => new Request('https://router.example.com/o/v', { method: 'PROPFIND', headers });

  it('forwards the headers a DAV client depends on', () => {
    // Depth and Destination carry the method's semantics; dropping either turns
    // a correct request into a wrong one at the backend.
    const out = buildProxiedHeaders(
      req({ Depth: '1', Destination: 'https://router.example.com/o2/v2', Authorization: 'Basic eA==' }),
      'https://router.example.com',
      'https://b.com',
    );
    expect(out.get('Depth')).toBe('1');
    expect(out.get('Destination')).toBe('https://b.com/o2/v2');
    expect(out.get('Authorization')).toBe('Basic eA==');
  });

  it('drops hop-by-hop and host headers', () => {
    const out = buildProxiedHeaders(
      req({ Host: 'router.example.com', Connection: 'keep-alive', 'X-Custom': 'v' }),
      'https://router.example.com',
      'https://b.com',
    );
    expect(out.get('Host')).toBeNull();
    expect(out.get('Connection')).toBeNull();
    expect(out.get('X-Custom')).toBeNull();
  });

  it('never forwards a stale content-length', () => {
    // `fetch` recomputes it from the body stream we hand it; a copied value
    // desynchronizes from the actual body.
    const out = buildProxiedHeaders(req({ 'Content-Length': '999' }), 'https://router.example.com', 'https://b.com');
    expect(out.get('Content-Length')).toBeNull();
    expect(PASSTHROUGH_REQUEST_HEADERS.has('content-length')).toBe(false);
  });

  it('never forwards a Host header', () => {
    expect(PASSTHROUGH_REQUEST_HEADERS.has('host')).toBe(false);
  });

  it('rewrites a same-origin Destination and leaves a cross-origin one alone', () => {
    const same = buildProxiedHeaders(
      req({ Destination: 'https://router.example.com/o2/v2?backend=x' }),
      'https://router.example.com',
      'https://b.com',
    );
    expect(same.get('Destination')).toBe('https://b.com/o2/v2');
    const cross = buildProxiedHeaders(req({ Destination: 'https://elsewhere.com/o2/v2' }), 'https://router.example.com', 'https://b.com');
    expect(cross.get('Destination')).toBe('https://elsewhere.com/o2/v2');
  });
});

describe('rewriteDestinationForBackend', () => {
  it('rewrites a relative destination against the router origin', () => {
    expect(rewriteDestinationForBackend('/o2/v2', 'https://router.example.com', 'https://b.com')).toBe('https://b.com/o2/v2');
  });

  it('strips the router selector so it never leaks to the backend', () => {
    expect(
      rewriteDestinationForBackend('https://router.example.com/o2/v2?backend=office', 'https://router.example.com', 'https://b.com'),
    ).toBe('https://b.com/o2/v2');
  });

  it('passes an unparsable destination through rather than dropping it', () => {
    // The backend reports the real error; silently deleting the header would
    // make a MOVE/COPY fail with a confusing "missing Destination".
    expect(rewriteDestinationForBackend('http://[bad', 'https://router.example.com', 'https://b.com')).toBe('http://[bad');
  });

  it('returns null for an absent destination', () => {
    expect(rewriteDestinationForBackend(null, 'https://router.example.com', 'https://b.com')).toBeNull();
  });
});

describe('buildProbeHeaders', () => {
  it('replaces the caller credentials with a synthetic one', () => {
    // The candidate set is attacker-influenced, so a probe must never carry the
    // caller's real password to a third-party origin.
    const incoming = new Request('https://router.example.com/o/v', {
      method: 'PROPFIND',
      headers: { Authorization: 'Basic dmljdGltOnNlY3cmV0', Cookie: 'session=abc', 'Cf-Access-Jwt-Assertion': 'jwt.here' },
    });
    const out = buildProbeHeaders(incoming, 'https://router.example.com', 'https://b.com');
    expect(out.get('Authorization')).toBe(PROBE_AUTHORIZATION);
    expect(out.get('Cookie')).toBeNull();
    expect(out.get('Cf-Access-Jwt-Assertion')).toBeNull();
  });

  it('uses a credential that grants nothing', () => {
    // A backend must not be able to accept a probe as a real identity.
    expect(Buffer.from(PROBE_AUTHORIZATION.replace('Basic ', ''), 'base64').toString('utf8')).toBe('router-probe:');
  });

  it('always sets the probe Depth and content type', () => {
    const out = buildProbeHeaders(new Request('https://router.example.com/o/v'), 'https://router.example.com', 'https://b.com');
    expect(out.get('Depth')).toBe('0');
    expect(out.get('Content-Type')).toBe('application/xml');
  });

  it('still sets a credential when the caller sent none', () => {
    // Some backends reject a request with no Authorization at all; presence is
    // what makes them answer with a challenge, which is a useful signal.
    const out = buildProbeHeaders(new Request('https://router.example.com/o/v'), 'https://router.example.com', 'https://b.com');
    expect(out.get('Authorization')).toBe(PROBE_AUTHORIZATION);
  });
});

describe('filterProxiedResponseHeaders', () => {
  it('forwards the DAV and range headers a client needs', () => {
    const out = filterProxiedResponseHeaders(
      new Headers({ DAV: '1, 2', 'Content-Type': 'application/xml', ETag: '"a"', 'Content-Range': 'bytes 0-1/2', 'MS-Author-Via': 'DAV' }),
    );
    expect(out.get('DAV')).toBe('1, 2');
    expect(out.get('ETag')).toBe('"a"');
    expect(out.get('Content-Range')).toBe('bytes 0-1/2');
    expect(out.get('MS-Author-Via')).toBe('DAV');
  });

  it('drops connection-specific headers', () => {
    const out = filterProxiedResponseHeaders(new Headers({ Connection: 'keep-alive', 'Transfer-Encoding': 'chunked', Server: 'nginx' }));
    expect(out.get('Connection')).toBeNull();
    expect(out.get('Transfer-Encoding')).toBeNull();
    expect(out.get('Server')).toBeNull();
  });

  it('does not forward a stale content-length', () => {
    const out = filterProxiedResponseHeaders(new Headers({ 'Content-Length': '10' }));
    expect(out.get('Content-Length')).toBeNull();
    expect(PASSTHROUGH_RESPONSE_HEADERS.has('content-length')).toBe(false);
  });

  it('keeps www-authenticate so a client can read the Basic challenge', () => {
    expect(filterProxiedResponseHeaders(new Headers({ 'WWW-Authenticate': 'Basic realm="x"' })).get('WWW-Authenticate')).toBe(
      'Basic realm="x"',
    );
  });
});

describe('resolveBackend', () => {
  const a = backend('1', 'https://a.com');
  const b = backend('2', 'https://b.com');

  it('picks the explicit slug case-insensitively', () => {
    expect(resolveBackend([a, b], 'S1').kind).toBe('single');
  });

  it('reports not-found for an unknown explicit slug', () => {
    // Distinct from "ambiguous": the caller named a backend that does not exist.
    expect(resolveBackend([a, b], 'nope').kind).toBe('not-found');
  });

  it('reports not-found for an empty candidate set', () => {
    expect(resolveBackend([], null).kind).toBe('not-found');
  });

  it('uses the lone backend without a selector', () => {
    const only = resolveBackend([a], null);
    expect(only.kind).toBe('single');
    expect(only.kind === 'single' && only.backend.id).toBe('1');
  });

  it('reports ambiguous when several match and none was named', () => {
    // Guessing here would send a request to the wrong origin.
    expect(resolveBackend([a, b], null).kind).toBe('ambiguous');
  });

  it('ignores an empty or whitespace selector', () => {
    for (const slug of ['', ' '.repeat(3), null]) {
      expect(resolveBackend([a, b], slug).kind, JSON.stringify(slug)).toBe('ambiguous');
    }
  });
});

describe('fetchWithTimeout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the upstream response on success', async () => {
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 207 }));
    const res = await fetchWithTimeout(new Request('https://x/'), {}, 1000);
    expect(res.status).toBe(207);
  });

  it('aborts and rejects when the backend exceeds the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      (_i: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            // A real aborted `fetch` rejects with a `DOMException` named
            // `AbortError`, which is how a caller tells an abort from a
            // transport failure. Assigning `.name` on a plain `Error` would
            // model the same signal less faithfully.
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    await expect(fetchWithTimeout(new Request('https://x/'), {}, 20)).rejects.toThrow();
  });

  it('clears its timer on success so it cannot fire during a long body read', async () => {
    // The timeout bounds time-to-headers; a pending timer would abort the
    // response body mid-transfer.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.stubGlobal('fetch', async () => new Response('ok'));
    await fetchWithTimeout(new Request('https://x/'), {}, 50);
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('getProxyTimeoutMs', () => {
  it('reads the configured value', () => {
    expect(getProxyTimeoutMs({ BACKEND_FETCH_TIMEOUT_MS: '1234' })).toBe(1234);
  });

  it('falls back on a malformed value or unusable env', () => {
    // Called from fail-soft paths; it must never throw.
    expect(getProxyTimeoutMs({ BACKEND_FETCH_TIMEOUT_MS: 'soon' })).toBe(8000);
    expect(getProxyTimeoutMs(null)).toBe(8000);
    expect(getProxyTimeoutMs(undefined)).toBe(8000);
  });
});

describe('failure diagnostics', () => {
  it('flattens whitespace and truncates a long body', () => {
    expect(truncateSnippet('a\n\n  b   c')).toBe('a b c');
    expect(truncateSnippet('x'.repeat(300))).toHaveLength(201);
  });

  it('leaves a short body untouched', () => {
    expect(truncateSnippet('short', 200)).toBe('short');
  });

  it('explains a Cloudflare 522 as an egress problem, not an app problem', () => {
    expect(describeBackendFailure(522, '')).toMatch(/could not reach the backend origin/i);
  });

  it('points at Access when a backend answers with a redirect', () => {
    expect(describeBackendFailure(302, '')).toMatch(/Access/i);
  });

  it('points at credentials on a 401 or 403', () => {
    expect(describeBackendFailure(401, '')).toMatch(/credentials/i);
    expect(describeBackendFailure(403, '')).toMatch(/credentials/i);
  });

  it('includes a body snippet when one is available', () => {
    expect(describeBackendFailure(500, 'stack trace here')).toMatch(/stack trace here/);
  });

  it('stays readable for an unremarkable status', () => {
    expect(describeBackendFailure(404, '')).toMatch(/404/);
  });
});

describe('probeCandidateBackends', () => {
  const a = backend('1', 'https://a.com');
  const b = backend('2', 'https://b.com');
  const incoming = new Request('https://router.example.com/o/v', { method: 'PROPFIND' });
  const input = { volumePath: '/o/v', incoming, routerOrigin: 'https://router.example.com', timeoutMs: 1000 };

  const stubStatuses = (byOrigin: Record<string, number>) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (i: RequestInfo | URL) => {
      const url = String(i instanceof Request ? i.url : i);
      calls.push(url);
      return new Response(null, { status: byOrigin[new URL(url).origin] ?? 404 });
    });
    return calls;
  };

  it('routes to the unique backend that has the volume', async () => {
    stubStatuses({ 'https://a.com': 207, 'https://b.com': 404 });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('single');
    expect(result.kind === 'single' && result.backend.id).toBe('1');
  });

  it('reports ambiguous when several backends have it', async () => {
    stubStatuses({ 'https://a.com': 207, 'https://b.com': 207 });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('ambiguous');
  });

  it('reports not-found when no backend has it', async () => {
    stubStatuses({ 'https://a.com': 404, 'https://b.com': 410 });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('not-found');
  });

  it('reports unavailable when a candidate is indeterminate', async () => {
    // 502 is neither a hit nor a miss, so the honest answer is "cannot tell",
    // which the caller turns into a 502 rather than a false 404.
    stubStatuses({ 'https://a.com': 502, 'https://b.com': 502 });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('unavailable');
  });

  it('routes to a lone auth-gated candidate so the client sees the real challenge', async () => {
    stubStatuses({ 'https://a.com': 401, 'https://b.com': 404 });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('single');
    expect(result.kind === 'single' && result.backend.id).toBe('1');
  });

  it('reports ambiguous for several auth-gated candidates', async () => {
    stubStatuses({ 'https://a.com': 401, 'https://b.com': 403 });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('ambiguous');
  });

  it('does not treat an Access login redirect as proof the volume exists', async () => {
    // A real backend behind Access answers 302 for an unauthenticated probe.
    // Reading that as a hit pinned a route to the wrong origin for 24h.
    stubStatuses({ 'https://a.com': 302, 'https://b.com': 404 });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('unavailable');
  });

  it('survives a candidate whose fetch throws', async () => {
    vi.stubGlobal('fetch', async (i: RequestInfo | URL) => {
      const url = String(i instanceof Request ? i.url : i);
      if (new URL(url).origin === 'https://a.com') throw new Error('connection refused');
      return new Response(null, { status: 207 });
    });
    const result = await probeCandidateBackends({ ...input, candidates: [a, b] });
    expect(result.kind).toBe('single');
  });

  it('refuses to fan out past the candidate cap', async () => {
    // One unauthenticated request must not be able to force N parallel egress
    // connections.
    const many = Array.from({ length: MAX_PROBE_CANDIDATES + 3 }, (_, i) => backend(String(i), `https://b${i}.com`));
    const calls = stubStatuses({});
    const result = await probeCandidateBackends({ ...input, candidates: many });
    expect(result.kind).toBe('ambiguous');
    expect(calls).toHaveLength(0);
  });

  it('probes exactly up to the cap', async () => {
    const many = Array.from({ length: MAX_PROBE_CANDIDATES }, (_, i) => backend(String(i), `https://b${i}.com`));
    const calls = stubStatuses({});
    await probeCandidateBackends({ ...input, candidates: many });
    expect(calls).toHaveLength(MAX_PROBE_CANDIDATES);
  });
});
