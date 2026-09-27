import type { AggregatedVolume, BackendHealth, DavHrefPrefixMode, VolumeDetail } from '../types';
import { apiDelete, apiGet, apiPatch } from '../lib/api';

function withBackend(params: Record<string, string | undefined>, backend?: string | null): Record<string, string | undefined> {
  return backend ? { ...params, backend } : params;
}

/**
 * The backend's volume JSON, verbatim.
 *
 * The router proxies `/user/volumes*` without reshaping it, so every field is
 * the backend's own. `hrefPrefixMode` is optional because a backend predating
 * the setting omits it — coercing here rather than at each read keeps the
 * "unknown means the conforming default" rule in one place.
 */
type VolumeJson = {
  owner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  hrefPrefixMode?: DavHrefPrefixMode;
  href: string;
};

function toVolumeDetail(data: VolumeJson): VolumeDetail {
  return {
    owner: data.owner,
    name: data.name,
    fullName: `${data.owner}/${data.name}`,
    description: data.description,
    isPrivate: data.isPrivate,
    hrefPrefixMode: data.hrefPrefixMode === 'root' ? 'root' : 'base',
    href: data.href,
  };
}

export async function listMyVolumes(backend?: string | null): Promise<{ volumes: AggregatedVolume[]; backends: BackendHealth[] }> {
  const data = await apiGet<{ volumes?: AggregatedVolume[]; backends?: BackendHealth[] }>('/user/volumes', withBackend({}, backend));
  return { volumes: data.volumes ?? [], backends: data.backends ?? [] };
}

export async function loadVolume(owner: string, volume: string, backend?: string | null): Promise<VolumeDetail> {
  const data = await apiGet<VolumeJson>(
    `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`,
    withBackend({}, backend),
  );
  return toVolumeDetail(data);
}

export async function updateVolume(
  owner: string,
  volume: string,
  patch: { description?: string | null; isPrivate?: boolean; hrefPrefixMode?: DavHrefPrefixMode },
  backend?: string | null,
): Promise<VolumeDetail> {
  const data = await apiPatch<VolumeJson>(
    `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}${backend ? `?backend=${encodeURIComponent(backend)}` : ''}`,
    patch,
  );
  return toVolumeDetail(data);
}

export async function deleteVolume(owner: string, volume: string, backend?: string | null): Promise<{ ok: boolean }> {
  const qs = backend ? `?backend=${encodeURIComponent(backend)}` : '';
  return apiDelete<{ ok: boolean }>(`/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}${qs}`);
}
