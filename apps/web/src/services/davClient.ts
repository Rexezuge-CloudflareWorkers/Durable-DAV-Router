import type { DavEntry } from '../types';
import { BackendError, readDav } from '../lib/api';
import { parseMultistatus, stripSlashes } from '../lib/davXml';

/**
 * Public volume base, as it appears in `DAV:href` values (RFC 4918 §8.3).
 *
 * The upstream backend is a Durable-DAV deployment whose hrefs carry
 * `/<owner>/<volume>`; `parseMultistatus` needs that prefix to recover
 * volume-relative paths.
 */
function davBase(owner: string, volume: string): string {
  return `/${owner}/${volume}`;
}

function volumeBase(owner: string, volume: string, backend?: string | null): string {
  // Router browser plane: same path shape as the backend
  // (`/user/volumes/:owner/:volume/files`), authed via the Access session.
  // `?backend=` selects the upstream when several backends are registered.
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/files`;
  return backend ? `${base}?backend=${encodeURIComponent(backend)}` : base;
}

/**
 * Origin to resolve relative request URLs against.
 *
 * `entryUrl` returns a root-relative path, so `moveEntry`/`copyEntry` have to
 * absolutise it for the `Destination` header. `globalThis.location` exists in a
 * browser but not in a worker or a test runner, and reading `.origin` off
 * `undefined` throws before the request is ever made — so the two must resolve it
 * the same guarded way.
 */
function requestOrigin(): string {
  return globalThis.location?.origin ?? 'https://localhost';
}

function entryUrl(owner: string, volume: string, innerPath: string, backend?: string | null): string {
  // Defence in depth: even if a caller skips `cleanPath`, a `..` segment must
  // never escape the volume base. `encodeURIComponent` leaves `.` alone, so
  // the browser would otherwise resolve `..` out of
  // `/user/volumes/<o>/<v>/files` and the request would leave the volume.
  //
  // The filter removes dot segments rather than resolving them, so a traversal
  // attempt lands back inside the volume (`photos/../notes.txt` →
  // `photos/notes.txt`) instead of escaping or failing. The containment check
  // below is the second layer behind this filter, not the primary defence.
  const clean = stripSlashes(innerPath)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
  const suffix = clean === '' ? '/' : `/${clean.split('/').map(encodeURIComponent).join('/')}`;
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/files`;
  const url = `${base}${suffix}`;
  // Fail closed rather than emit a request outside the volume. The `?backend=`
  // selector is appended only after this check, so it cannot affect the
  // pathname being validated.
  if (!new URL(url, requestOrigin()).pathname.startsWith(`${base}/`)) {
    throw new Error('Refusing to build a DAV URL outside the volume base.');
  }
  return backend ? `${url}${url.includes('?') ? '&' : '?'}backend=${encodeURIComponent(backend)}` : url;
}

async function davFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status === 207) return response;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let type: string | null = null;
    let message = text || `HTTP ${response.status}`;
    try {
      const data = JSON.parse(text) as { Exception?: { Type?: string; Message?: string } };
      if (typeof data?.Exception?.Type === 'string') type = data.Exception.Type;
      if (typeof data?.Exception?.Message === 'string' && data.Exception.Message) message = data.Exception.Message;
    } catch {
      // Plain-text WebDAV errors surface as-is (truncated).
      message = message.length > 500 ? `${message.slice(0, 500)}…` : message;
    }
    throw new BackendError(message, type, response.status);
  }
  return response;
}

/**
 * One page of a directory listing.
 *
 * `paged` is `false` when the backend did not answer with `X-Dav-Page-Count`,
 * which means it does not implement paging — an older Durable-DAV behind this
 * router. The caller then treats the returned entries as the complete listing.
 * Note the router forwards those headers itself (`BackendProxyService`), so their
 * absence means the *backend* lacks paging, not that the proxy stripped them.
 */
export interface DavListing {
  entries: DavEntry[];
  page: number;
  limit: number;
  /**
  Total entries, or `null` when the backend did not report one.
  */
  total: number | null;
  paged: boolean;
}

function readPagingHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function listDirectory(
  owner: string,
  volume: string,
  innerPath: string,
  backend?: string | null,
  page?: { page: number; limit: number },
): Promise<DavListing> {
  const base = entryUrl(owner, volume, innerPath, backend);
  // `entryUrl` already appends `?backend=` when a selector is present, so the
  // join has to respect an existing query. Two `?` would silently drop the
  // paging parameters, and the symptom would be a pager stuck on page 1.
  const paging = page === undefined ? '' : `&page=${encodeURIComponent(String(page.page))}&limit=${encodeURIComponent(String(page.limit))}`;
  const url = paging === '' ? base : `${base}${base.includes('?') ? paging : `?${paging.slice(1)}`}`;
  const body = `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>`;
  const response = await davFetch(url, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  // Read the headers before the body: `readDav` consumes the stream.
  const total = readPagingHeader(response, 'X-Dav-Page-Count');
  const effectivePage = readPagingHeader(response, 'X-Dav-Page');
  const effectiveLimit = readPagingHeader(response, 'X-Dav-Page-Limit');
  const xml = await readDav(response);
  const entries = parseMultistatus(xml, innerPath, davBase(owner, volume));
  return {
    entries,
    // Echo back the *effective* values: a request for page 99 of a 1-page
    // collection is served page 1, and the URL should say so.
    page: effectivePage ?? page?.page ?? 1,
    limit: effectiveLimit ?? page?.limit ?? Math.max(1, entries.length),
    total,
    paged: total !== null,
  };
}

export async function createDirectory(owner: string, volume: string, innerPath: string, backend?: string | null): Promise<void> {
  await davFetch(entryUrl(owner, volume, innerPath, backend), { method: 'MKCOL' });
}

export async function uploadFile(
  owner: string,
  volume: string,
  innerPath: string,
  file: File | Blob,
  backend?: string | null,
): Promise<void> {
  await davFetch(entryUrl(owner, volume, innerPath, backend), {
    method: 'PUT',
    headers: { 'Content-Type': (file as File).type || 'application/octet-stream' },
    body: file,
  });
}

export async function deleteEntry(owner: string, volume: string, innerPath: string, backend?: string | null): Promise<void> {
  await davFetch(entryUrl(owner, volume, innerPath, backend), { method: 'DELETE' });
}

export async function moveEntry(
  owner: string,
  volume: string,
  fromPath: string,
  toPath: string,
  overwrite = true,
  backend?: string | null,
): Promise<void> {
  const destination = new URL(entryUrl(owner, volume, toPath, backend), requestOrigin()).href;
  await davFetch(entryUrl(owner, volume, fromPath, backend), {
    method: 'MOVE',
    headers: { Destination: destination, Overwrite: overwrite ? 'T' : 'F' },
  });
}

export async function copyEntry(
  owner: string,
  volume: string,
  fromPath: string,
  toPath: string,
  overwrite = true,
  backend?: string | null,
): Promise<void> {
  const destination = new URL(entryUrl(owner, volume, toPath, backend), requestOrigin()).href;
  await davFetch(entryUrl(owner, volume, fromPath, backend), {
    method: 'COPY',
    headers: { Destination: destination, Overwrite: overwrite ? 'T' : 'F' },
  });
}

export function downloadUrl(owner: string, volume: string, innerPath: string, backend?: string | null): string {
  return entryUrl(owner, volume, innerPath, backend);
}

export { volumeBase };
