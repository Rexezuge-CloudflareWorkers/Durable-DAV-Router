import { describe, expect, it } from 'vitest';
import { parseMultistatus, joinDavPath, parentDavPath } from '../apps/web/src/lib/davXml';

/**
 * Fixtures mirror what a Durable-DAV backend emits for
 * `PROPFIND /user/volumes/:owner/:volume/files` with `Depth: 1`.
 *
 * The backend renders hrefs relative to the volume root (its
 * `getResourceHref(key, isCollection)` is called with an empty base), so a
 * root listing produces `/`, `/photos/`, `/notes.txt` — no owner segment. The
 * router forwards that body verbatim, so the browser parser sees exactly this
 * shape. Namespace prefixes and self-closing tags vary between renderers, so
 * both forms appear below.
 */

describe('web PROPFIND parser (browser side)', () => {
  it('parses a Depth:1 listing and drops the self response', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response><href>/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/photos/</href><propstat><prop><resourcetype><collection/></resourcetype><getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</getlastmodified></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/notes.txt</href><propstat><prop><resourcetype/><getcontentlength>42</getcontentlength><getcontenttype>text/plain</getcontenttype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries.map((e) => e.name)).toEqual(['photos', 'notes.txt']);
    expect(entries[0]?.isCollection).toBe(true);
    expect(entries[0]?.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(entries[1]?.isCollection).toBe(false);
    expect(entries[1]?.size).toBe(42);
    expect(entries[1]?.contentType).toBe('text/plain');
    expect(entries[1]?.path).toBe('notes.txt');
  });

  it('parses subdirectory listings with nested paths, collections first', () => {
    const xml = `<multistatus xmlns="DAV:">
  <response><href>/photos/a.jpg</href><propstat><prop><resourcetype/><getcontentlength>7</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/photos/raw/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(xml, 'photos');
    // The self entry (`/photos/`) is dropped because it equals the base path.
    expect(entries.map((e) => e.path)).toEqual(['photos/raw', 'photos/a.jpg']);
    expect(entries.map((e) => e.name)).toEqual(['raw', 'a.jpg']);
  });

  it('is namespace-prefix agnostic', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/f.txt</d:href><d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'f.txt', path: 'f.txt', isCollection: false, size: 3 });
  });

  it('detects collections via resourcetype', () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/d/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isCollection).toBe(true);
  });

  it('percent-decodes hrefs so unicode and spaced names survive', () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/rapport%20final%C3%A9.pdf</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries[0]?.name).toBe('rapport finalé.pdf');
  });

  it('strips a query string from the href before deriving the path', () => {
    // Backends may append cache-busting or `?backend=` selectors to hrefs.
    const xml = `<multistatus xmlns="DAV:"><response><href>/f.txt?backend=office</href><propstat><prop><resourcetype/><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries[0]?.path).toBe('f.txt');
  });

  it('returns nothing for a body that is not a multistatus', () => {
    // A 401/403 body forwarded verbatim is HTML or JSON, not DAV XML.
    expect(parseMultistatus('<html><body>Access denied</body></html>', '')).toEqual([]);
    expect(parseMultistatus('', '')).toEqual([]);
  });

  it('ignores non-2xx propstat blocks', () => {
    // A 404 propstat for an absent dead property is normal and must not drop
    // the entry's live properties.
    const xml = `<multistatus xmlns="DAV:"><response><href>/f.txt</href>
      <propstat><prop><getcontentlength>5</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat>
      <propstat><prop><x-dead-prop/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
    </response></multistatus>`;
    const entries = parseMultistatus(xml, '');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.size).toBe(5);
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
