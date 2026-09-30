import type { BucketCredential, CreatedBucketCredential } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

function credentialBase(owner: string, volume: string, backend?: string | null): string {
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/credentials`;
  return backend ? `${base}?backend=${encodeURIComponent(backend)}` : base;
}

function withBackendQuery(base: string, backend?: string | null): string {
  if (!backend) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}backend=${encodeURIComponent(backend)}`;
}

export async function listBucketCredentials(owner: string, volume: string, backend?: string | null): Promise<BucketCredential[]> {
  const data = await apiGet<{ credentials?: BucketCredential[] }>(credentialBase(owner, volume, backend));
  return data.credentials ?? [];
}

/**
`readOnly` sits before `backend` because the selector is the trailing argument
throughout this file. Putting it last would let a caller's `readOnly` land in
`backend` and become a `?backend=true` selector, which resolves to no backend
and 404s the request — a wrong access level would be reported as a missing
bucket.
*/
export async function createBucketCredential(
  owner: string,
  volume: string,
  name: string,
  expiresInDays?: number,
  readOnly?: boolean,
  backend?: string | null,
): Promise<CreatedBucketCredential> {
  return apiPost<CreatedBucketCredential>(credentialBase(owner, volume, backend), { name, expiresInDays, readOnly });
}

/**
Flip a credential between read-only and full access.

Proxied to the backend, which owns the flag. The router's `PATCH` on
`/user/volumes/:owner/:volume/*` forwards the path and body verbatim, so this
needs no route of its own.
*/
export async function setBucketCredentialReadOnly(
  owner: string,
  volume: string,
  credentialId: string,
  readOnly: boolean,
  backend?: string | null,
): Promise<void> {
  const base = `${credentialBase(owner, volume)}/${encodeURIComponent(credentialId)}`;
  await apiPatch<{ credentialId: string; readOnly: boolean }>(withBackendQuery(base, backend), { readOnly });
}

export async function revokeBucketCredential(owner: string, volume: string, credentialId: string, backend?: string | null): Promise<void> {
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/credentials/${encodeURIComponent(credentialId)}`;
  await apiDelete<{ ok: boolean }>(withBackendQuery(base, backend));
}
