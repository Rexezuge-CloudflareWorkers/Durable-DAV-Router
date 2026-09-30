import type { AggregatedVolume, BackendHealth, DavHrefPrefixMode, VolumeDetail } from '../types';
import { apiDelete, apiGet, apiPatch } from '../lib/api';
import { withBackendParam, withBackendSelector } from '../lib/backendSelector';

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
  const data = await apiGet<{ volumes?: AggregatedVolume[]; backends?: BackendHealth[] }>('/user/volumes', withBackendParam({}, backend));
  return { volumes: data.volumes ?? [], backends: data.backends ?? [] };
}

export async function loadVolume(owner: string, volume: string, backend?: string | null): Promise<VolumeDetail> {
  const data = await apiGet<VolumeJson>(
    `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`,
    withBackendParam({}, backend),
  );
  return toVolumeDetail(data);
}

export async function updateVolume(
  owner: string,
  volume: string,
  patch: { description?: string | null; isPrivate?: boolean; hrefPrefixMode?: DavHrefPrefixMode },
  backend?: string | null,
): Promise<VolumeDetail> {
  const url = withBackendSelector(`/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`, backend);
  return toVolumeDetail(await apiPatch<VolumeJson>(url, patch));
}

export async function deleteVolume(owner: string, volume: string, backend?: string | null): Promise<{ ok: boolean }> {
  const url = withBackendSelector(`/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`, backend);
  return apiDelete<{ ok: boolean }>(url);
}
