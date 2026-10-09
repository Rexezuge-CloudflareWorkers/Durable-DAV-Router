import type { BucketReplication, ReplicationConflict } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost, getBackendErrorStatus } from '../lib/api';
import { withBackendSelector } from '../lib/backendSelector';

/**
 * Intervals the UI offers, in minutes.
 *
 * Mirrored from the backend's `REPLICATION_INTERVALS`. The backend validates
 * against its own closed list and answers a `400` for anything else, so this copy
 * exists only to render a dropdown that cannot produce an invalid choice before
 * the server list arrives — the backend remains the enforcement point.
 */
export const REPLICATION_INTERVALS = [15, 60, 360, 720, 1440, 10_080] as const;

/**
 * The modes the UI offers, mirrored from the backend's `REPLICATION_MODES`.
 *
 * The same arrangement as the intervals above: a local copy so the dropdown
 * cannot render blank or offer a value the server will reject, with the backend
 * remaining the enforcement point. Unlike the intervals there is no server-sent
 * list to reconcile against — `GET /replications` returns `allowedIntervals` but
 * no modes — so the router cannot hide an option a particular backend does not
 * support, and does not try. A backend predating `pull-only` answers `400` for
 * it, which reaches the notice bar through the ordinary error path.
 *
 * `pull-only` is the one-way import: the remote is the sole writer, nothing is
 * ever pushed back, and — with `mirrorDeletions` — local paths the remote lacks
 * are removed rather than kept.
 */
export const REPLICATION_MODES = ['keep-both', 'sync', 'pull-only', 'copy-only'] as const;

export type ReplicationMode = (typeof REPLICATION_MODES)[number];

/**
Human label for an interval. Minutes under an hour, then hours/days.
*/
export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) {
    const hours = minutes / 60;
    return `${Number.isSafeInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  const days = minutes / 1440;
  return `${Number.isSafeInteger(days) ? days : days.toFixed(1)}d`;
}

/**
What a target is, for display.

A sibling bucket's "URL" is its owner/volume path, which is what a user needs to
see to recognise it; a third-party server's is shown as configured.
*/
export function targetLabel(replication: BucketReplication): string {
  if (replication.targetKind === 'dav-volume') {
    const base = `${replication.remoteOwner}/${replication.remoteVolume}`;
    return replication.remotePath === '' ? base : `${base}/${replication.remotePath}`;
  }
  return replication.remoteUrl + (replication.remotePath === '' ? '' : `/${replication.remotePath}`);
}

/**
Whether a backend can answer the replication API at all.

A `404` here means *this backend predates replication*, and it is distinguishable
from "this bucket is not yours" only because the settings tab already loaded
`GET /user/volumes/:owner/:volume` — a row there proves the bucket exists and is
owned, and the backend answers `404` for a foreign volume too, so a caller who
does not own the bucket never reaches this call. `VolumeSettingsTab` renders the
card inside its `detail` gate for exactly that reason.
*/
export type ReplicationSupport =
  | { supported: false }
  | { supported: true; replications: BucketReplication[]; allowedIntervals: number[] };

/**
The backend's base for one bucket's replications, with an optional suffix.

One function rather than a base helper plus string concatenation at each call
site, because the selector has to be appended to the *finished* path. Building
`.../replications/r1` first and appending `?backend=x` after it — then adding
`/run` — puts the query in the middle: `/replications/r1?backend=office/run`,
which addresses a different resource and 404s. Every sub-resource here
(`/run`, `/conflicts`, `/conflicts/:id/resolve`) is exactly that shape, so the
three of them were the three ways to get it wrong.

`backend` is threaded through `withBackendSelector` rather than inlined, because a
dropped selector does not fail loudly here — it 409s (or, with one backend,
silently targets the wrong one) and the user sees an empty target list on a bucket
that has three.
*/
function replicationUrl(owner: string, volume: string, suffix: string, backend?: string | null): string {
  return withBackendSelector(
    `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/replications${suffix}`,
    backend,
  );
}

function replicationBase(owner: string, volume: string, backend?: string | null): string {
  return replicationUrl(owner, volume, '', backend);
}

/**
 * Targets configured for one bucket, or the reason there are none to report.
 *
 * The unsupported case resolves rather than throws: it is an answer about the
 * backend, not a failure of this request, and routing it through the throw path
 * would put a version-skew notice in the error bar where it reads as a fault.
 */
export async function listReplications(owner: string, volume: string, backend?: string | null): Promise<ReplicationSupport> {
  try {
    const data = await apiGet<{ replications?: BucketReplication[]; allowedIntervals?: number[] }>(
      replicationBase(owner, volume, backend),
    );
    return {
      supported: true,
      replications: data.replications ?? [],
      allowedIntervals: data.allowedIntervals ?? [...REPLICATION_INTERVALS],
    };
  } catch (error) {
    if (getBackendErrorStatus(error) === 404) return { supported: false };
    throw error;
  }
}

export type CreateReplicationInput = {
  targetKind: 'dav' | 'dav-volume';
  remoteUrl?: string;
  remoteOwner?: string;
  remoteVolume?: string;
  remotePath?: string;
  authKind: 'none' | 'basic' | 'bearer';
  username?: string;
  secret?: string;
  mode: ReplicationMode;
  /**
   * `pull-only` only: delete local paths the remote does not have, making this an
   * exact mirror rather than a safe copy. Omitted for every other mode — the
   * backend refuses it there, so sending it is a `400` rather than a no-op, and
   * sending `false` is worse than sending nothing: it is a field an older
   * backend silently ignores, which reads as "accepted" for a setting it never
   * stored.
   */
  mirrorDeletions?: boolean;
  intervalMinutes: number;
  enabled?: boolean;
};

export async function createReplication(
  owner: string,
  volume: string,
  input: CreateReplicationInput,
  backend?: string | null,
): Promise<BucketReplication> {
  const data = await apiPost<{ replication: BucketReplication }>(replicationBase(owner, volume, backend), input);
  return data.replication;
}

export async function updateReplication(
  owner: string,
  volume: string,
  replicationId: string,
  patch: { mode?: ReplicationMode; mirrorDeletions?: boolean; intervalMinutes?: number; enabled?: boolean },
  backend?: string | null,
): Promise<BucketReplication> {
  const data = await apiPatch<{ replication: BucketReplication }>(
    replicationUrl(owner, volume, `/${encodeURIComponent(replicationId)}`, backend),
    patch,
  );
  return data.replication;
}

export async function deleteReplication(
  owner: string,
  volume: string,
  replicationId: string,
  backend?: string | null,
): Promise<void> {
  await apiDelete<{ ok: boolean }>(replicationUrl(owner, volume, `/${encodeURIComponent(replicationId)}`, backend));
}

/**
 * Ask for one slice immediately.
 *
 * `started` (202) is the normal answer: the backend detaches the work into
 * `waitUntil` and returns, because a slice runs for tens of seconds and a client
 * timeout would look like a failed sync that had in fact succeeded. The UI must
 * report `started` as success rather than as a no-op.
 */
export async function runReplicationNow(
  owner: string,
  volume: string,
  replicationId: string,
  backend?: string | null,
): Promise<{ sync: 'started' | 'done'; status?: string; error?: string | null }> {
  return apiPost<{ sync: 'started' | 'done'; status?: string; error?: string | null }>(
    replicationUrl(owner, volume, `/${encodeURIComponent(replicationId)}/run`, backend),
    {},
  );
}

export async function listReplicationConflicts(
  owner: string,
  volume: string,
  replicationId: string,
  backend?: string | null,
): Promise<ReplicationConflict[]> {
  const data = await apiGet<{ conflicts?: ReplicationConflict[] }>(
    replicationUrl(owner, volume, `/${encodeURIComponent(replicationId)}/conflicts`, backend),
  );
  return data.conflicts ?? [];
}

/**
 * Mark one recorded decision reconciled.
 *
 * Idempotent on the backend: a second call answers `resolved: false` rather than
 * `404`, because a client retrying after a dropped response must not be told the
 * decision does not exist.
 */
export async function resolveReplicationConflict(
  owner: string,
  volume: string,
  replicationId: string,
  conflictId: string,
  backend?: string | null,
): Promise<boolean> {
  const data = await apiPost<{ resolved: boolean }>(
    replicationUrl(
      owner,
      volume,
      `/${encodeURIComponent(replicationId)}/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      backend,
    ),
    {},
  );
  return data.resolved;
}