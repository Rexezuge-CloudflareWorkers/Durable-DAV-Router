import type { DavEntry } from '../types';
import { BackendError, readDav } from '../lib/api';
import { parseMultistatus, stripSlashes } from '../lib/davXml';

function volumeBase(owner: string, volume: string, backend?: string | null): string {
  // Router browser plane: same path shape as the backend
  // (`/user/volumes/:owner/:volume/files`), authed via the Access session.
  // `?backend=` selects the upstream when several backends are registered.
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/files`;
  return backend ? `${base}?backend=${encodeURIComponent(backend)}` : base;
}

function entryUrl(owner: string, volume: string, innerPath: string, backend?: string | null): string {
  const clean = stripSlashes(innerPath);
  const suffix = clean === '' ? '/' : `/${clean.split('/').map(encodeURIComponent).join('/')}`;
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/files`;
  const url = `${base}${suffix}`;
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

export async function listDirectory(owner: string, volume: string, innerPath: string, backend?: string | null): Promise<DavEntry[]> {
  const url = entryUrl(owner, volume, innerPath, backend);
  const body = `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>`;
  const response = await davFetch(url, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  const xml = await readDav(response);
  return parseMultistatus(xml, innerPath);
}

export async function createDirectory(owner: string, volume: string, innerPath: string, backend?: string | null): Promise<void> {
  await davFetch(entryUrl(owner, volume, innerPath, backend), { method: 'MKCOL' });
}

export async function uploadFile(owner: string, volume: string, innerPath: string, file: File | Blob, backend?: string | null): Promise<void> {
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
  const destination = new URL(entryUrl(owner, volume, toPath, backend), globalThis.location.origin).href;
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
  const destination = new URL(entryUrl(owner, volume, toPath, backend), globalThis.location.origin).href;
  await davFetch(entryUrl(owner, volume, fromPath, backend), {
    method: 'COPY',
    headers: { Destination: destination, Overwrite: overwrite ? 'T' : 'F' },
  });
}

export function downloadUrl(owner: string, volume: string, innerPath: string, backend?: string | null): string {
  return entryUrl(owner, volume, innerPath, backend);
}

export { volumeBase };
