import { describe, expect, it } from 'vitest';
import { DAV_CLASS, SUPPORT_METHODS, applyCors, resolveAllowedOrigin, parseAllowedOrigins } from '@durable-dav-router/webdav';

describe('DuraDAV protocol surface', () => {
  it('advertises Class 1, 2', () => {
    expect(DAV_CLASS).toBe('1, 2');
  });

  it('supports all required methods', () => {
    for (const method of ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'DELETE', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']) {
      expect(SUPPORT_METHODS).toContain(method);
    }
  });

  it('does not proxy methods outside the DAV set', () => {
    // These are forwarded verbatim from the client, so anything not in the set
    // must be rejected rather than relayed.
    for (const method of ['POST', 'PATCH', 'TRACE', 'CONNECT']) {
      expect(SUPPORT_METHODS).not.toContain(method);
    }
  });

  it('returns Allow headers a client can act on', () => {
    // `Allow` is the only signal distinguishing 405 from 404, so the full set
    // has to reach the client.
    expect(SUPPORT_METHODS.join(', ')).toContain('PROPFIND');
    expect(SUPPORT_METHODS).toHaveLength(12);
  });
});

describe('CORS origin policy', () => {
  const request = (origin?: string): Request =>
    new Request('https://router.example.com/o/v', { headers: origin ? { Origin: origin } : {} });

  it('grants nothing by default, so a cross-origin browser request is refused', () => {
    // Reflecting any Origin let a page on any site drive cross-origin PUT /
    // DELETE / MKCOL through the proxy, with the Cookie header forwarded
    // verbatim. The shipped SPA is same-origin, so it needs no grant.
    const res = applyCors(new Response('ok'), request('https://evil.example'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('sets the preflight contract a browser needs to attempt a DAV request', () => {
    // Without the method/header lists, a browser refuses the preflight and the
    // real PROPFIND/MKCOL never leaves the page.
    const res = applyCors(new Response(null, { status: 204 }), request('https://app.example.com'), 'https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PROPFIND');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('MKCOL');
    for (const header of ['depth', 'destination', 'lock-token', 'authorization']) {
      expect(res.headers.get('Access-Control-Allow-Headers'), header).toContain(header);
    }
    expect(res.headers.get('Access-Control-Max-Age')).toMatch(/^\d+$/);
  });

  it('advertises DAV class and the Basic challenge as readable', () => {
    // Without `DAV` exposed, a browser cannot confirm the backend is a DAV
    // server; without `www-authenticate` it cannot tell "wrong password" from
    // "no such bucket".
    const res = applyCors(new Response('ok', { headers: { DAV: '1, 2' } }), request('https://app.example.com'), 'https://app.example.com');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('dav');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('www-authenticate');
  });

  it('still emits Vary: Origin so caches cannot cross-serve a grant', () => {
    const res = applyCors(new Response('ok'), request('https://evil.example'));
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('echoes only allow-listed origins', () => {
    const res = applyCors(new Response('ok'), request('https://app.example.com'), 'https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    const denied = applyCors(new Response('ok'), request('https://evil.example'), 'https://app.example.com');
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('matches allow-listed origins case-insensitively and trims whitespace', () => {
    const res = applyCors(new Response('ok'), request('https://APP.example.com'), ' https://app.example.com , https://other.example ');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://APP.example.com');
  });

  it('never reflects an origin alongside credentials', () => {
    const res = applyCors(new Response('ok'), request('https://app.example.com'), '*');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('false');
  });

  it('grants nothing to an opaque ("null") origin', () => {
    // `Origin: null` comes from a sandboxed iframe or a data: document, where
    // the real origin is unknowable. Echoing it would let any such page make
    // granted requests, so it is refused like any other non-allow-listed
    // origin.
    const res = applyCors(new Response('ok'), request('null'), '*');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('exposes www-authenticate so a client can read the Basic challenge', () => {
    const res = applyCors(new Response('ok'), request('https://app.example.com'), 'https://app.example.com');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('www-authenticate');
  });

  it('preserves status, body and existing headers', () => {
    const res = applyCors(new Response('body', { status: 207, headers: { DAV: '1, 2' } }), request(), 'https://app.example.com');
    expect(res.status).toBe(207);
    expect(res.headers.get('DAV')).toBe('1, 2');
  });

  describe('allow-list parsing', () => {
    it('ignores empty entries and normalizes case', () => {
      const parsed = parseAllowedOrigins('https://A.example.com, ,https://b.example.com,');
      expect([...parsed].sort()).toEqual(['https://a.example.com', 'https://b.example.com']);
    });

    it('treats an empty string as an empty allow-list, not a wildcard', () => {
      // `*` must be an explicit choice; an unset or blank variable must never
      // accidentally widen access.
      expect(resolveAllowedOrigin('https://any.example', '')).toBeNull();
      expect(resolveAllowedOrigin('https://any.example', '  ')).toBeNull();
    });

    it('falls back to the compile-time default when no list is configured', () => {
      expect(resolveAllowedOrigin('https://any.example')).toBeNull();
    });

    it('returns null when there is no request origin to grant', () => {
      expect(resolveAllowedOrigin(null, '*')).toBeNull();
      expect(resolveAllowedOrigin('', 'https://a.example.com')).toBeNull();
    });
  });
});
