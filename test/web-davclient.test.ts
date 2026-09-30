import { describe, expect, it } from 'vitest';
import {
  copyEntry,
  createDirectory,
  deleteEntry,
  downloadUrl,
  listDirectory,
  moveEntry,
  uploadFile,
  volumeBase,
} from '../apps/web/src/services/davClient';
import { parseMultistatus } from '../apps/web/src/lib/davXml';
import { BackendError } from '../apps/web/src/lib/api';

/**
 * `davClient` is the only place the SPA turns a parsed `entry.path` back into a
 * request URL, so it is where a parser/server disagreement becomes a user-visible
 * failure. It also builds every URL from `?path=`, which is user-supplied.
 *
 * These cases pin both halves of that contract:
 * - a parsed path round-trips into a URL that stays inside the volume, and
 * - a path that tries to leave the volume never produces a request at all.
 */

const OWNER = 'test';
const VOLUME = 'bucket';
/**
Volume base as it appears in `DAV:href` (RFC 4918 §8.3).
*/
const DAV_BASE = `/${OWNER}/${VOLUME}`;
const FILES = `/user/volumes/${OWNER}/${VOLUME}/files`;

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * Run `body` with `fetch` stubbed, returning the result and every request the
 * client made. `vi.stubGlobal`/`vi.unstubAllGlobals` is used rather than a
 * hand-rolled save/restore so an exception mid-test cannot leak the stub into
 * the next one.
 */
async function withFetch<T>(body: string, run: () => Promise<T>, status = 207, headers: Record<string, string> = {}): Promise<{ result: T; calls: Call[] }> {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      // 204/205/304 are null-body statuses; the Response constructor rejects a body.
      return new Response(status === 204 ? null : body, { status, headers });
    },
  );
  try {
    return { result: await run(), calls };
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
The single request `body` expects the client to make.
*/
async function capture(body: string, run: () => Promise<unknown>, status = 207): Promise<Call> {
  const { calls } = await withFetch(body, run, status);
  const first = calls[0];
  if (!first) throw new Error('no request was made');
  return first;
}

/**
Pathname of a (possibly relative) request target.
*/
function pathname(url: string): string {
  return new URL(url, 'https://router.example.com').pathname;
}

describe('downloadUrl (the request-URL builder)', () => {
  it('addresses the volume root', () => {
    expect(downloadUrl(OWNER, VOLUME, '')).toBe(`${FILES}/`);
  });

  it('addresses a nested file', () => {
    expect(downloadUrl(OWNER, VOLUME, 'photos/raw/a.jpg')).toBe(`${FILES}/photos/raw/a.jpg`);
  });

  it('percent-encodes each segment', () => {
    expect(downloadUrl(OWNER, VOLUME, 'photos/p q.txt')).toBe(`${FILES}/photos/p%20q.txt`);
  });

  it('keeps the ?backend= selector off the pathname', () => {
    expect(downloadUrl(OWNER, VOLUME, 'notes.txt', 'office')).toBe(`${FILES}/notes.txt?backend=office`);
    // The selector must not disturb the path or the containment check.
    expect(pathname(downloadUrl(OWNER, VOLUME, 'notes.txt', 'office'))).toBe(`${FILES}/notes.txt`);
  });

  it('neutralises a path that tries to escape the volume base', () => {
    // The guarantee is that no `?path=` value can produce a request outside the
    // volume. `encodeURIComponent` leaves `.` alone, so without the segment
    // filter the browser would resolve these to `/user/volumes/<owner>/admin`.
    // The filter drops the dot segments, which lands the request back inside the
    // volume rather than failing it — the fail-closed check inside `entryUrl` is
    // the second layer, not the primary defence.
    const cases: Array<[string, string]> = [
      ['../admin', `${FILES}/admin`],
      ['../../admin', `${FILES}/admin`],
      ['photos/../../admin', `${FILES}/photos/admin`],
      ['..', `${FILES}/`],
      ['photos/..', `${FILES}/photos`],
    ];
    for (const [attempt, expected] of cases) {
      expect(pathname(downloadUrl(OWNER, VOLUME, attempt)), attempt).toBe(expected);
    }
    // The selector must not open a side door past the same check.
    expect(pathname(downloadUrl(OWNER, VOLUME, '../admin', 'office'))).toBe(`${FILES}/admin`);
  });

  it('removes dot segments without resolving them', () => {
    // The filter is a segment drop, not a path resolver: `photos` survives
    // alongside the removed `..`. The result is still in-volume and addressable.
    expect(downloadUrl(OWNER, VOLUME, 'photos/../notes.txt')).toBe(`${FILES}/photos/notes.txt`);
  });

  it('drops dot segments rather than escaping', () => {
    // A `..` that does not escape is simply removed, leaving a valid in-volume
    // request instead of a hard failure.
    expect(downloadUrl(OWNER, VOLUME, './photos/a.jpg')).toBe(`${FILES}/photos/a.jpg`);
    expect(downloadUrl(OWNER, VOLUME, 'photos/./a.jpg')).toBe(`${FILES}/photos/a.jpg`);
  });

  it('collapses empty segments so the server never sees a//b', () => {
    // `a//b` is a guaranteed 400 from the backend's `isValidInnerPath`.
    expect(downloadUrl(OWNER, VOLUME, 'photos//a.jpg')).toBe(`${FILES}/photos/a.jpg`);
  });
});

describe('listDirectory', () => {
  const prefixedBody = (inner: string) =>
    `<?xml version="1.0" encoding="utf-8"?><multistatus xmlns="DAV:">
<response><href>${DAV_BASE}${inner === '' ? '/' : `/${inner}/`}</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>${DAV_BASE}${inner === '' ? '' : `/${inner}/`}notes.txt</href><propstat><prop><resourcetype/><getcontentlength>5</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;

  it('sends PROPFIND with Depth: 1 at the browser plane', async () => {
    const call = await capture(prefixedBody('photos'), () => listDirectory(OWNER, VOLUME, 'photos'));
    expect(call.init.method).toBe('PROPFIND');
    expect((call.init.headers as Record<string, string>)['Depth']).toBe('1');
    expect(pathname(call.url)).toBe(`${FILES}/photos`);
  });

  it('strips the volume base from a real prefixed body', async () => {
    const { result } = await withFetch(prefixedBody('photos'), () => listDirectory(OWNER, VOLUME, 'photos'));
    // The self-response reduces to the base path and is dropped; the child keeps
    // a volume-relative path that the URL builder can address.
    expect(result.entries).toMatchObject([{ name: 'notes.txt', path: 'photos/notes.txt', isCollection: false }]);
  });

  it('carries the ?backend= selector on a read', async () => {
    const call = await capture(prefixedBody(''), () => listDirectory(OWNER, VOLUME, '', 'office'));
    expect(call.url).toBe(`${FILES}/?backend=office`);
  });

  /**
   * `listDirectory` now returns a `DavListing` rather than a bare array, so
   * these read `.entries`.
   */
  it('appends paging parameters without a selector', async () => {
    const call = await capture(prefixedBody('photos'), () => listDirectory(OWNER, VOLUME, 'photos', null, { page: 2, limit: 50 }));
    expect(call.url).toBe(`${FILES}/photos?page=2&limit=50`);
  });

  it('joins paging parameters onto an existing ?backend= selector with &', async () => {
    // Two `?` would silently drop the paging parameters, and the symptom would
    // be a pager that never advances past page 1.
    const call = await capture(prefixedBody('photos'), () => listDirectory(OWNER, VOLUME, 'photos', 'office', { page: 3, limit: 100 }));
    expect(call.url).toBe(`${FILES}/photos?backend=office&page=3&limit=100`);
  });

  it('omits paging parameters entirely when no page is requested', async () => {
    // A DAV-plane read and a WebDAV client's read must stay byte-identical to
    // before: no query string at all.
    const call = await capture(prefixedBody(''), () => listDirectory(OWNER, VOLUME, ''));
    expect(call.url).toBe(`${FILES}/`);
  });

  it('reports the paging metadata the backend returned', async () => {
    const { result } = await withFetch(prefixedBody('photos'), () => listDirectory(OWNER, VOLUME, 'photos', null, { page: 2, limit: 50 }), 207, {
      'X-Dav-Page-Count': '12431',
      'X-Dav-Page': '2',
      'X-Dav-Page-Limit': '50',
    });
    expect(result).toMatchObject({ total: 12_431, page: 2, limit: 50, paged: true });
  });

  /**
   * Version skew: a backend that does not implement paging omits the headers.
   * The client must then read the body as a *complete* listing rather than
   * silently assuming it is page 1 of many.
   */
  it('reports an unpaged listing when the backend omits the paging headers', async () => {
    const { result } = await withFetch(prefixedBody('photos'), () => listDirectory(OWNER, VOLUME, 'photos', null, { page: 2, limit: 50 }));
    expect(result.paged).toBe(false);
    expect(result.total).toBeNull();
    expect(result.entries).toMatchObject([{ name: 'notes.txt', path: 'photos/notes.txt' }]);
  });

  it('adopts the page the backend says it served, over the page requested', async () => {
    // The backend clamps an out-of-range page; the URL should follow the served
    // page so the address bar agrees with the rows on screen.
    const { result } = await withFetch(prefixedBody('photos'), () => listDirectory(OWNER, VOLUME, 'photos', null, { page: 99, limit: 50 }), 207, {
      'X-Dav-Page-Count': '12',
      'X-Dav-Page': '1',
      'X-Dav-Page-Limit': '50',
    });
    expect(result.page).toBe(1);
  });

  it('surfaces a non-207 as a BackendError carrying the type', async () => {
    const body = JSON.stringify({ Exception: { Type: 'NotFound', Message: 'Volume not found' } });
    await expect(withFetch(body, () => listDirectory(OWNER, VOLUME, 'nope'), 404)).rejects.toMatchObject({
      errorType: 'NotFound',
      status: 404,
    });
  });
});

describe('mutations', () => {
  it('MKCOL, PUT and DELETE target the addressed path', async () => {
    const mkcol = await capture('', () => createDirectory(OWNER, VOLUME, 'photos'), 201);
    expect(mkcol.init.method).toBe('MKCOL');
    expect(pathname(mkcol.url)).toBe(`${FILES}/photos`);

    const put = await capture('', () => uploadFile(OWNER, VOLUME, 'photos/a.jpg', new Blob(['x'])), 201);
    expect(put.init.method).toBe('PUT');
    expect(pathname(put.url)).toBe(`${FILES}/photos/a.jpg`);

    const del = await capture('', () => deleteEntry(OWNER, VOLUME, 'photos/a.jpg'), 204);
    expect(del.init.method).toBe('DELETE');
    expect(pathname(del.url)).toBe(`${FILES}/photos/a.jpg`);
  });

  it('MOVE rewrites Destination onto the same browser plane', async () => {
    const call = await capture('', () => moveEntry(OWNER, VOLUME, 'a.txt', 'photos/b.txt'), 201);
    const headers = call.init.headers as Record<string, string>;
    expect(call.init.method).toBe('MOVE');
    expect(new URL(headers['Destination']).pathname).toBe(`${FILES}/photos/b.txt`);
    expect(headers['Overwrite']).toBe('T');
  });

  it('COPY rewrites Destination and honours Overwrite: F', async () => {
    const call = await capture('', () => copyEntry(OWNER, VOLUME, 'a.txt', 'b.txt', false), 201);
    const headers = call.init.headers as Record<string, string>;
    expect(call.init.method).toBe('COPY');
    expect(new URL(headers['Destination']).pathname).toBe(`${FILES}/b.txt`);
    expect(headers['Overwrite']).toBe('F');
  });

  it('neutralises a destination that tries to escape the volume', async () => {
    // A MOVE/COPY `Destination` is built by the same helper, so the same
    // guarantee holds: the request and its Destination stay inside the volume.
    const call = await capture('', () => moveEntry(OWNER, VOLUME, 'a.txt', '../admin/b.txt'), 201);
    const headers = call.init.headers as Record<string, string>;
    expect(pathname(call.url)).toBe(`${FILES}/a.txt`);
    expect(new URL(headers['Destination']).pathname).toBe(`${FILES}/admin/b.txt`);
  });
});

describe('parser ⇄ URL round trip', () => {
  it('feeds a parsed path straight back into a valid request URL', () => {
    // The invariant the bucket browser depends on: whatever `path` the parser
    // produces must be addressable. If either half drifts, this fails.
    const body = `<multistatus xmlns="DAV:">
<response><href>${DAV_BASE}/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>${DAV_BASE}/photos/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>${DAV_BASE}/photos/a b.jpg</href><propstat><prop><resourcetype/><getcontentlength>7</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const entries = parseMultistatus(body, '', DAV_BASE);
    for (const entry of entries) {
      const url = downloadUrl(OWNER, VOLUME, entry.path);
      // Never leaves the volume, and resolves to the same resource the href named.
      expect(pathname(url).startsWith(`${FILES}/`)).toBe(true);
      expect(decodeURIComponent(pathname(url))).toBe(`${FILES}/${entry.path}`);
    }
    // A spaced name survives the round trip intact.
    expect(entries.map((e) => e.path)).toEqual(['photos', 'photos/a b.jpg']);
    expect(downloadUrl(OWNER, VOLUME, 'photos/a b.jpg')).toBe(`${FILES}/photos/a%20b.jpg`);
  });
});

describe('volumeBase', () => {
  it('builds the browser-plane base, with and without a selector', () => {
    expect(volumeBase(OWNER, VOLUME)).toBe(FILES);
    expect(volumeBase(OWNER, VOLUME, 'office')).toBe(`${FILES}?backend=office`);
  });

  it('is the prefix every other helper builds on', () => {
    expect(downloadUrl(OWNER, VOLUME, '')).toBe(`${volumeBase(OWNER, VOLUME)}/`);
  });
});

describe('BackendError is what callers catch', () => {
  it('keeps the status and type on the instance', () => {
    const error = new BackendError('nope', 'NotFound', 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.errorType).toBe('NotFound');
  });
});
