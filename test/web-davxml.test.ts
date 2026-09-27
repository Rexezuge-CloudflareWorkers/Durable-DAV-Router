import { describe, expect, it } from 'vitest';
import { parseMultistatus, joinDavPath, parentDavPath } from '../apps/web/src/lib/davXml';

/**
 * Fixtures mirror what a Durable-DAV backend emits for
 * `PROPFIND /user/volumes/:owner/:volume/files[/inner]` with `Depth: 1`.
 *
 * Hrefs carry the volume base. RFC 4918 §8.3 requires every `DAV:href` to be a
 * URI reference that resolves against the *request* URL, and the request URL is
 * the backend's browser plane, so a root listing produces
 * `/test/bucket/`, `/test/bucket/photos/`, `/test/bucket/notes.txt`. The router
 * forwards that body verbatim (`RouterDavProxyRoutes` returns `upstream.body`
 * untouched), so the browser parser sees exactly this shape.
 *
 * These fixtures used to be *unprefixed* (`/`, `/photos/`), on the stated
 * assumption that "the backend renders hrefs relative to the volume root …
 * with an empty base". That was true before the backend gained §8.3 support and
 * became false afterwards — so the suite pinned the bug rather than the
 * contract: with prefixed hrefs the parser never recognised the self-response,
 * the volume root appeared as a row inside the volume root, and every path came
 * back carrying the base twice, which 404'd on the next request. Namespace
 * prefixes and self-closing tags vary between renderers, so both forms appear.
 */

const BASE = '/test/bucket';
const PREFIX = `${BASE}/`;

describe('web PROPFIND parser (browser side)', () => {
  it('parses a Depth:1 listing and drops the self response', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response><href>${PREFIX}</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>${PREFIX}photos/</href><propstat><prop><resourcetype><collection/></resourcetype><getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</getlastmodified></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>${PREFIX}notes.txt</href><propstat><prop><resourcetype/><getcontentlength>42</getcontentlength><getcontenttype>text/plain</getcontenttype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries.map((e) => e.name)).toEqual(['photos', 'notes.txt']);
    expect(entries[0]?.isCollection).toBe(true);
    expect(entries[0]?.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(entries[1]?.isCollection).toBe(false);
    expect(entries[1]?.size).toBe(42);
    expect(entries[1]?.contentType).toBe('text/plain');
    // Volume-relative, not `test/bucket/notes.txt`. The UI feeds `path` straight
    // back into the next request URL, so the base must be gone exactly once.
    expect(entries[1]?.path).toBe('notes.txt');
  });

  it('strips the volume base so the volume root is never a row in its own listing', () => {
    // Regression: the self `<response>` href is `<owner>/<volume>/`, which is
    // the prefix itself. Without stripping it, it does not equal the (empty)
    // base path, survives the self-drop, and renders as a phantom folder whose
    // `path` 404s when clicked.
    const xml = `<multistatus xmlns="DAV:">
  <response><href>${BASE}/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>${PREFIX}readme.txt</href><propstat><prop><resourcetype/><getcontentlength>9</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries.map((e) => e.path)).toEqual(['readme.txt']);
  });

  it('parses subdirectory listings with nested paths, collections first', () => {
    const xml = `<multistatus xmlns="DAV:">
  <response><href>${PREFIX}photos/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>${PREFIX}photos/a.jpg</href><propstat><prop><resourcetype/><getcontentlength>7</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>${PREFIX}photos/raw/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, 'photos', BASE);
    // The self entry (`…/photos/`) is dropped because it reduces to the base path.
    expect(entries.map((e) => e.path)).toEqual(['photos/raw', 'photos/a.jpg']);
    expect(entries.map((e) => e.name)).toEqual(['raw', 'a.jpg']);
  });

  it('parses a deeply nested subdirectory', () => {
    const xml = `<multistatus xmlns="DAV:">
  <response><href>${PREFIX}photos/raw/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>${PREFIX}photos/raw/p%20q.txt</href><propstat><prop><resourcetype/><getcontentlength>3</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, 'photos/raw', BASE);
    expect(entries.map((e) => e.path)).toEqual(['photos/raw/p q.txt']);
  });

  it('matches the volume base case-insensitively', () => {
    // Volume keys are lowercased at the backend's front door, but a `Destination`
    // or href may preserve the original casing. The two strings are the same
    // length, so slicing on the un-lowercased prefix stays correct.
    const xml = `<multistatus xmlns="DAV:"><response><href>/Test/Bucket/readme.txt</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '', '/test/bucket');
    expect(entries.map((e) => e.path)).toEqual(['readme.txt']);
  });

  it('still accepts unprefixed hrefs from a backend that predates the §8.3 change', () => {
    // Tolerance is deliberate: the router fronts arbitrary backends, so it must
    // not break against one that emits volume-relative hrefs.
    const xml = `<multistatus xmlns="DAV:">
  <response><href>/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/dir/f.txt</href><propstat><prop><resourcetype/><getcontentlength>5</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries.map((e) => e.path)).toEqual(['dir/f.txt']);
  });

  it('is namespace-prefix agnostic', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${PREFIX}f.txt</d:href><d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'f.txt', path: 'f.txt', isCollection: false, size: 3 });
  });

  it('detects collections via resourcetype', () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>${PREFIX}d/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isCollection).toBe(true);
  });

  it('percent-decodes hrefs so unicode and spaced names survive', () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>${PREFIX}rapport%20final%C3%A9.pdf</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries[0]?.name).toBe('rapport finalé.pdf');
  });

  it('strips a query string from the href before deriving the path', () => {
    // Backends may append cache-busting or `?backend=` selectors to hrefs.
    const xml = `<multistatus xmlns="DAV:"><response><href>${PREFIX}f.txt?backend=office</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries[0]?.path).toBe('f.txt');
  });

  it('tolerates an absolute href', () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>https://dav.example.com${PREFIX}f.txt</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries[0]?.path).toBe('f.txt');
  });

  it('returns nothing for a body that is not a multistatus', () => {
    // A 401/403 body forwarded verbatim is HTML or JSON, not DAV XML.
    expect(parseMultistatus('<html><body>Access denied</body></html>', '', BASE)).toEqual([]);
    expect(parseMultistatus('', '', BASE)).toEqual([]);
  });

  it('ignores non-2xx propstat blocks', () => {
    // A 404 propstat for an absent dead property is normal and must not drop
    // the entry's live properties.
    const xml = `<multistatus xmlns="DAV:"><response><href>${PREFIX}f.txt</href>
      <propstat><prop><getcontentlength>5</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat>
      <propstat><prop><x-dead-prop/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
    </response></multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.size).toBe(5);
  });

  it('does not mistake a volume whose name prefixes another for the listed volume', () => {
    // `startsWith(prefix + '/')` is what makes this safe: a sibling volume
    // `bucket2` must not be stripped by the base `bucket`.
    const xml = `<multistatus xmlns="DAV:"><response><href>/test/bucket2/f.txt</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '', BASE);
    expect(entries[0]?.path).toBe('test/bucket2/f.txt');
  });
});

describe('web dav path helpers', () => {
  it('joins and walks parents', () => {
    expect(joinDavPath('', 'a')).toBe('a');
    expect(joinDavPath('a/b', 'c')).toBe('a/b/c');
    expect(parentDavPath('a/b/c')).toBe('a/b');
    expect(parentDavPath('a')).toBe('');
    expect(parentDavPath('')).toBeNull();
  });
});

/**
 * The `path` a listing yields is fed straight back into the next request URL, so
 * these cases pair "parse a real body" with "use the parsed `path`". A
 * parser/server disagreement is invisible when either half is checked alone —
 * that is exactly how the unprefixed-fixture bug above shipped green while the
 * bucket browser could not open a single file.
 */
describe('web PROPFIND parser against a root-anchored backend', () => {
  const ROOT_XML = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response><href>/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/photos/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/notes.txt</href><propstat><prop><resourcetype/><getcontentlength>42</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;

  it('drops the self response and yields volume-relative paths', () => {
    // The volume root's own href is `/` here rather than `/test/bucket/`. The
    // parser must reduce both to the same volume-relative empty path and drop
    // it, or the root renders as a phantom row inside itself.
    const entries = parseMultistatus(ROOT_XML, '', BASE);
    expect(entries.map((e) => [e.name, e.path, e.isCollection])).toEqual([
      ['photos', 'photos', true],
      ['notes.txt', 'notes.txt', false],
    ]);
    expect(entries.map((e) => e.path)).not.toContain('');
  });

  it('produces paths the browser plane can request', () => {
    // The parsed `path` must be a valid inner path for the browser plane, which
    // is `/user/volumes/<owner>/<volume>/files[/<path>]` — the same base the
    // request went to, whatever shape the hrefs arrived in.
    const entries = parseMultistatus(ROOT_XML, '', BASE);
    const file = entries.find((e) => !e.isCollection)!;
    const inner = file.path;
    expect(inner).toBe('notes.txt');
    // No base residue: a leading `test/bucket` here is the 404 the sibling fix
    // was written to remove, and it would return in root mode if the prefix
    // strip were ever made unconditional.
    expect(inner.startsWith('test/')).toBe(false);
    expect(inner.split('/').some((s) => ['', '.', '..'].includes(s))).toBe(false);
  });

  it('still recognises the self response when listing a subdirectory', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response><href>/photos/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/photos/a.txt</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, 'photos', BASE);
    expect(entries.map((e) => e.path)).toEqual(['photos/a.txt']);
    // Strictly below the folder being listed, never a sibling or an ancestor.
    expect(entries[0]?.path.startsWith('photos/')).toBe(true);
  });

  it('distinguishes a root-anchored child from the listed folder itself', () => {
    // Both hrefs reduce to a path that must not be confused: `/photos/` is the
    // self response when listing `photos`, and a child when listing the root.
    expect(parseMultistatus(ROOT_XML, 'photos', BASE).map((e) => e.path)).not.toContain('photos');
    expect(parseMultistatus(ROOT_XML, '', BASE).map((e) => e.path)).toContain('photos');
  });
});
