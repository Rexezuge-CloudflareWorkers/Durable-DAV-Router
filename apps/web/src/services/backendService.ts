import type { RouterBackend } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

export async function listBackends(): Promise<RouterBackend[]> {
  const data = await apiGet<{ backends?: RouterBackend[] }>('/user/backends');
  return data.backends ?? [];
}

export async function createBackend(input: { slug: string; baseUrl: string; displayName?: string | null }): Promise<RouterBackend> {
  return apiPost<RouterBackend>('/user/backends', input);
}

export async function updateBackend(
  slug: string,
  patch: { baseUrl?: string; displayName?: string | null },
): Promise<RouterBackend> {
  return apiPatch<RouterBackend>(`/user/backends/${encodeURIComponent(slug)}`, patch);
}

export async function deleteBackend(slug: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/user/backends/${encodeURIComponent(slug)}`);
}
