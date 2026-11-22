import type { BucketCredential, CreatedBucketCredential } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { withBackendSelector } from '../lib/backendSelector';

function credentialBase(owner: string, volume: string, backend?: string | null): string {
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/credentials`;
  return withBackendSelector(base, backend);
}

export async function listBucketCredentials(owner: string, volume: string, backend?: string | null): Promise<BucketCredential[]> {
  const data = await apiGet<{ credentials?: BucketCredential[] }>(credentialBase(owner, volume, backend));
  return data.credentials ?? [];
}

/**
`readOnly` and `server` sit before `backend` because the selector is the
trailing argument throughout this file. Putting either last would let a
caller's `true` land in `backend` and become a `?backend=true` selector, which
resolves to no backend and 404s the request — a wrong access level or the wrong
credential type would be reported as a missing bucket.

`server` is sent only when true, so a plain credential's body is unchanged and
keeps its ordinary expiry; the backend rejects a non-boolean flag.
*/
export async function createBucketCredential(
  owner: string,
  volume: string,
  name: string,
  expiresInDays?: number,
  readOnly?: boolean,
  server?: boolean,
  backend?: string | null,
): Promise<CreatedBucketCredential> {
  return apiPost<CreatedBucketCredential>(credentialBase(owner, volume, backend), {
    name,
    expiresInDays,
    readOnly,
    ...(server && { server: true }),
  });
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
  await apiPatch<{ credentialId: string; readOnly: boolean }>(withBackendSelector(base, backend), { readOnly });
}

export async function revokeBucketCredential(owner: string, volume: string, credentialId: string, backend?: string | null): Promise<void> {
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/credentials/${encodeURIComponent(credentialId)}`;
  await apiDelete<{ ok: boolean }>(withBackendSelector(base, backend));
}
