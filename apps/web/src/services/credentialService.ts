import type { BucketCredential, CreatedBucketCredential } from '../types';
import { apiDelete, apiGet, apiPost } from '../lib/api';

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

export async function createBucketCredential(
  owner: string,
  volume: string,
  name: string,
  expiresInDays?: number,
  backend?: string | null,
): Promise<CreatedBucketCredential> {
  return apiPost<CreatedBucketCredential>(credentialBase(owner, volume, backend), { name, expiresInDays });
}

export async function revokeBucketCredential(owner: string, volume: string, credentialId: string, backend?: string | null): Promise<void> {
  const base = `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/credentials/${encodeURIComponent(credentialId)}`;
  await apiDelete<{ ok: boolean }>(withBackendQuery(base, backend));
}
