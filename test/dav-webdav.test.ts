import { describe, expect, it } from 'vitest';
import {
  escapeXml,
  getResourceHref,
  decodeResourcePath,
  getParentPath,
  parseDestinationPath,
  isSameOrDescendantPath,
  normalizeVolumeKey,
  splitVolumePath,
  parsePropfindRequest,
  parseProppatchRequest,
  parseTimeout,
  normalizeLockToken,
  determineLockDepth,
  DAV_CLASS,
  SUPPORT_METHODS,
  applyCors,
  getDeadPropertyKey,
  isProtectedProperty,
  generatePropfindResponse,
} from '@durable-dav-router/webdav';
import { DavCredentialUtil } from '@durable-dav-router/shared/utils';

describe('DuraDAV path helpers (RFC 4918)', () => {
  it('escapes XML', () => {
    expect(escapeXml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&apos;');
  });

  it('builds hrefs with collection slash', () => {
    expect(getResourceHref('', true)).toBe('/');
    expect(getResourceHref('a/b', true)).toBe('/a/b/');
    expect(getResourceHref('a/b c', false)).toBe('/a/b%20c');
  });

  it('round-trips decode', () => {
    expect(decodeResourcePath('/')).toBe('');
    expect(decodeResourcePath('/a/b%20c/')).toBe('a/b c');
  });

  it('computes parent', () => {
    expect(getParentPath('a/b/c')).toBe('a/b');
    expect(getParentPath('a')).toBe('');
  });

  it('rejects cross-origin Destination', () => {
    expect(parseDestinationPath('https://other.test/a', 'https://example.test/b')).toBeNull();
    expect(parseDestinationPath('/alice/vol/file', 'https://example.test/alice/vol/')).toBe('alice/vol/file');
  });

  it('detects self/descendant for COPY/MOVE 403-equivalent guard', () => {
    expect(isSameOrDescendantPath('a', 'a')).toBe(true);
    expect(isSameOrDescendantPath('a', 'a/b')).toBe(true);
    expect(isSameOrDescendantPath('a/b', 'a')).toBe(false);
    expect(isSameOrDescendantPath('', 'a')).toBe(true);
  });

  it('normalizes volume keys case-insensitively (one DO per volume)', () => {
    expect(normalizeVolumeKey('Alice', 'Photos')).toBe('alice/photos');
  });

  it('splits /owner/volume/inner paths (multi-volume routing)', () => {
    expect(splitVolumePath('/')).toBeNull();
    expect(splitVolumePath('/alice')).toBeNull();
    expect(splitVolumePath('/alice/photos/a/b')).toEqual({ owner: 'alice', volume: 'photos', innerPath: 'a/b' });
  });
});

describe('DuraDAV XML (PROPFIND/PROPPATCH)', () => {
  it('defaults empty PROPFIND body to allprop', () => {
    expect(parsePropfindRequest('')).toEqual({ mode: 'allprop' });
    expect(parsePropfindRequest('<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>')).toEqual({ mode: 'allprop' });
  });

  it('parses propname and prop modes', () => {
    expect(parsePropfindRequest('<propfind xmlns="DAV:"><propname/></propfind>')).toEqual({ mode: 'propname' });
    const prop = parsePropfindRequest('<propfind xmlns="DAV:"><prop><getcontentlength xmlns="DAV:"/></prop></propfind>');
    expect(prop?.mode).toBe('prop');
  });

  it('rejects malformed XML', () => {
    expect(parsePropfindRequest('<propfind><unclosed>')).toBeNull();
    expect(parsePropfindRequest('<wrong xmlns="DAV:"><allprop/></wrong>')).toBeNull();
  });

  it('parses PROPPATCH set/remove', () => {
    const parsed = parseProppatchRequest(
      '<propertyupdate xmlns="DAV:"><set><prop><foo xmlns="urn:x">bar</foo></prop></set><remove><prop><baz xmlns="urn:x"/></prop></remove></propertyupdate>',
    );
    expect(parsed?.operations).toHaveLength(2);
    expect(parsed?.operations[0].action).toBe('set');
    expect(parsed?.operations[1].action).toBe('remove');
  });

  it('protects live lock properties from PROPPATCH', () => {
    expect(isProtectedProperty('supportedlock')).toBe(true);
    expect(isProtectedProperty('lockdiscovery')).toBe(true);
    expect(isProtectedProperty({ namespaceURI: 'DAV:', localName: 'getcontentlength', prefix: null, valueXml: '' })).toBe(false);
    expect(getDeadPropertyKey('urn:x', 'foo')).toContain('dead_property:');
  });

  it('renders multistatus responses', () => {
    const xml = generatePropfindResponse(null, 'allprop');
    expect(xml).toContain('<response>');
    expect(xml).toContain('<href>/</href>');
  });
});

describe('DuraDAV locks (Class 2)', () => {
  it('normalizes lock tokens', () => {
    expect(normalizeLockToken('<urn:uuid:abc>')).toBe('abc');
    expect(normalizeLockToken('<opaquelocktoken:abc>')).toBe('abc');
  });

  it('determines depth (collections default infinity)', () => {
    expect(determineLockDepth(true, null)).toBe('infinity');
    expect(determineLockDepth(false, null)).toBe('0');
    expect(determineLockDepth(false, 'infinity')).toBe('infinity');
  });

  it('parses Timeout headers', () => {
    expect(parseTimeout(null).timeout).toContain('Second-');
    expect(parseTimeout('Infinite').timeout).toBe('Infinite');
    expect(parseTimeout('Second-60').timeout).toBe('Second-60');
    expect(parseTimeout('garbage').timeout).toContain('Second-');
  });
});

describe('DuraDAV protocol surface', () => {
  it('advertises Class 1, 2', () => {
    expect(DAV_CLASS).toBe('1, 2');
  });

  it('supports all required methods', () => {
    for (const method of ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'DELETE', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']) {
      expect(SUPPORT_METHODS).toContain(method);
    }
  });

  it('bucket credential usernames are descriptive and validated', () => {
    const username = DavCredentialUtil.generateUsername('photos');
    expect(username.startsWith('photos-')).toBe(true);
    expect(username).toMatch(/^[a-z0-9-]+$/);
    expect(username.includes(':')).toBe(false);
  });
});

describe('CORS origin policy', () => {
  const request = (origin?: string): Request => new Request('https://router.example.com/o/v', { headers: origin ? { Origin: origin } : {} });

  it('grants nothing by default, so a cross-origin browser request is refused', () => {
    // Reflecting any Origin let a page on any site drive cross-origin PUT /
    // DELETE / MKCOL through the proxy, with the Cookie header forwarded
    // verbatim. The shipped SPA is same-origin, so it needs no grant.
    const res = applyCors(new Response('ok'), request('https://evil.example'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
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

  it('exposes www-authenticate so a client can read the Basic challenge', () => {
    const res = applyCors(new Response('ok'), request('https://app.example.com'), 'https://app.example.com');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('www-authenticate');
  });

  it('grants nothing to an opaque ("null") origin', () => {
    // `Origin: null` comes from a sandboxed iframe or a data: document, where
    // the real origin is unknowable. Echoing it would let any such page make
    // granted requests, so it is refused like any other non-allow-listed
    // origin.
    const res = applyCors(new Response('ok'), request('null'), '*');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('preserves status, body and existing headers', () => {
    const res = applyCors(new Response('body', { status: 207, headers: { DAV: '1, 2' } }), request(), 'https://app.example.com');
    expect(res.status).toBe(207);
    expect(res.headers.get('DAV')).toBe('1, 2');
  });
});
