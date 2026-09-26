import type { RouterBackend } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

export async function listBackends(): Promise<RouterBackend[]> {
  const data = await apiGet<{ backends?: RouterBackend[] }>('/user/backends');
  return data.backends ?? [];
}

export async function createBackend(input: { slug: string; baseUrl: string; displayName?: string | null }): Promise<RouterBackend> {
  return apiPost<RouterBackend>('/user/backends', input);
}

export async function updateBackend(slug: string, patch: { baseUrl?: string; displayName?: string | null }): Promise<RouterBackend> {
  return apiPatch<RouterBackend>(`/user/backends/${encodeURIComponent(slug)}`, patch);
}

export async function deleteBackend(slug: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/user/backends/${encodeURIComponent(slug)}`);
}

export interface BackendProbe {
  slug: string;
  baseUrl: string;
  health: { status: number | null; error: string | null };
  volumes: { status: number | null; error: string | null };
}

export async function probeBackend(slug: string): Promise<BackendProbe> {
  return apiGet<BackendProbe>(`/user/backends/${encodeURIComponent(slug)}/probe`);
}

export async function getBackendIdentity(slug: string): Promise<{ slug: string; username: string | null }> {
  return apiGet<{ slug: string; username: string | null }>(`/user/backends/${encodeURIComponent(slug)}/me`);
}
