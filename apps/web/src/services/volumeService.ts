import type { AggregatedVolume, BackendHealth, VolumeDetail } from '../types';
import { apiDelete, apiGet, apiPatch } from '../lib/api';

function withBackend(params: Record<string, string | undefined>, backend?: string | null): Record<string, string | undefined> {
  return backend ? { ...params, backend } : params;
}

export async function listMyVolumes(backend?: string | null): Promise<{ volumes: AggregatedVolume[]; backends: BackendHealth[] }> {
  const data = await apiGet<{ volumes?: AggregatedVolume[]; backends?: BackendHealth[] }>('/user/volumes', withBackend({}, backend));
  return { volumes: data.volumes ?? [], backends: data.backends ?? [] };
}

export async function loadVolume(owner: string, volume: string, backend?: string | null): Promise<VolumeDetail> {
  const data = await apiGet<{ owner: string; name: string; description: string | null; isPrivate: boolean; href: string }>(
    `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`,
    withBackend({}, backend),
  );
  return {
    owner: data.owner,
    name: data.name,
    fullName: `${data.owner}/${data.name}`,
    description: data.description,
    isPrivate: data.isPrivate,
    href: data.href,
  };
}

export async function updateVolume(
  owner: string,
  volume: string,
  patch: { description?: string | null; isPrivate?: boolean },
  backend?: string | null,
): Promise<VolumeDetail> {
  const data = await apiPatch<{ owner: string; name: string; description: string | null; isPrivate: boolean; href: string }>(
    `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}${backend ? `?backend=${encodeURIComponent(backend)}` : ''}`,
    patch,
  );
  return {
    owner: data.owner,
    name: data.name,
    fullName: `${data.owner}/${data.name}`,
    description: data.description,
    isPrivate: data.isPrivate,
    href: data.href,
  };
}

export async function deleteVolume(owner: string, volume: string, backend?: string | null): Promise<{ ok: boolean }> {
  const qs = backend ? `?backend=${encodeURIComponent(backend)}` : '';
  return apiDelete<{ ok: boolean }>(`/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}${qs}`);
}
