import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight } from 'lucide-react';
import type { BucketReplication, ReplicationConflict } from '../../types';
import type { ReplicationSupport } from '../../services/replicationService';
import {
  deleteReplication,
  listReplicationConflicts,
  listReplications,
  resolveReplicationConflict,
  runReplicationNow,
  updateReplication,
} from '../../services/replicationService';
import { useAsyncLoad } from '../../hooks/useAsyncLoad';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { RefreshButton } from '../shared/RefreshButton';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { VolumeReplicationRow } from './VolumeReplicationRow';
import { VolumeReplicationForm } from './VolumeReplicationForm';
import { VolumeReplicationDecisions } from './VolumeReplicationDecisions';

/**
 * Per-bucket replication targets.
 *
 * A composer: it owns the fetching, the mutation calls, and which row is
 * expanded. The three presentational pieces are separate components because the
 * three things a user does here — read a target's state, add one, reconcile a
 * decision — have genuinely different concerns and different failure modes.
 *
 * ## Why "Sync now" reports "started"
 *
 * The backend detaches the slice into `waitUntil` and answers `202`. That is not
 * an optimisation: a slice runs for tens of seconds, and a client timeout would
 * look like a failed sync that had in fact succeeded. The notice says so
 * explicitly rather than leaving the user wondering whether anything happened.
 *
 * ## Nothing here is the router's
 *
 * Every call rides the `/user/volumes/:owner/:volume/*` wildcard, which forwards
 * the path and body verbatim. No target, credential, decision or schedule is
 * modelled, stored or enforced by the router — including the `mode` dropdown,
 * whose three values are the backend's conflict policy and the backend's to
 * interpret. The one judgement made locally is the `supported: false` branch,
 * and it is a statement about the backend, not about the bucket.
 */
export function VolumeReplicationCard({
  owner,
  volume,
  showNotice,
  backend,
}: {
  owner: string;
  volume: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  backend?: string | null;
}) {
  const { t } = useTranslation();
  /**
   * Which target the decision list belongs to.
   *
   * Tracked rather than carried on each conflict, because the backend's conflict
   * projection has no `replicationId` — the resolve route needs the pair, and
   * inferring it from list order would be a guess.
   */
  const [conflicts, setConflicts] = useState<ReplicationConflict[]>([]);
  const [conflictsFor, setConflictsFor] = useState<string | null>(null);
  /**
   * Which row is mid-request.
   *
   * A row id rather than one boolean: a slice runs for tens of seconds, and a
   * global flag would grey out every other target's controls for the duration.
   */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BucketReplication | null>(null);

  const {
    data: support,
    loading,
    reload,
  } = useAsyncLoad<ReplicationSupport>(() => listReplications(owner, volume, backend), {
    reloadKey: `${owner}\u{0}${volume}\u{0}${backend ?? ''}`,
    onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadReplications', 'Failed To Load Replications.')),
  });

  const refresh = reload;
  const rows = support?.supported === true ? support.replications : [];
  const intervals = support?.supported === true ? support.allowedIntervals : [];

  /**
   * A decision list that failed to load must not leave the panel up: an empty one
   * would read as "nothing to reconcile", which is a claim about the target's
   * audit trail that was never actually verified. So the panel closes, and the
   * failure is reported rather than swallowed — a catch that only cleared state
   * left the owner clicking "Show Decisions" again against a target that was
   * already refusing, with nothing anywhere to say why.
   */
  const loadConflicts = useCallback(
    async (replicationId: string) => {
      try {
        setConflicts(await listReplicationConflicts(owner, volume, replicationId, backend));
        setConflictsFor(replicationId);
      } catch (error) {
        setConflicts([]);
        setConflictsFor(null);
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadReplicationDecisions', 'Failed To Load Decisions.'));
      }
    },
    [owner, volume, backend, showNotice, t],
  );

  const syncNow = async (replication: BucketReplication) => {
    setBusyId(replication.replicationId);
    try {
      const result = await runReplicationNow(owner, volume, replication.replicationId, backend);
      showNotice(
        'success',
        result.sync === 'started'
          ? t('replication.syncStarted', 'Sync Started. It Continues In The Background.')
          : t('replication.syncDone', 'Sync Finished.'),
      );
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToRunReplication', 'Failed To Run Sync.'));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (replication: BucketReplication) => {
    setBusyId(replication.replicationId);
    try {
      await updateReplication(owner, volume, replication.replicationId, { enabled: !replication.enabled }, backend);
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateReplication', 'Failed To Update Replication.'));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const replicationId = removing.replicationId;
    setRemoving(null);
    setBusyId(replicationId);
    try {
      await deleteReplication(owner, volume, replicationId, backend);
      if (conflictsFor === replicationId) {
        setConflicts([]);
        setConflictsFor(null);
      }
      showNotice('success', t('replication.removed', 'Replication Removed.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDeleteReplication', 'Failed To Remove Replication.'));
    } finally {
      setBusyId(null);
    }
  };

  const resolve = async (conflict: ReplicationConflict) => {
    if (conflictsFor === null) return;
    try {
      await resolveReplicationConflict(owner, volume, conflictsFor, conflict.conflictId, backend);
      await loadConflicts(conflictsFor);
    } catch (error) {
      // The row stays visible on failure, deliberately: it vanishes on success and
      // persists on error, so the owner can retry instead of losing sight of a
      // decision they still need to make.
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToResolveConflict', 'Failed To Mark Resolved.'));
    }
  };

  const unsupported = support !== undefined && !support.supported;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4" aria-hidden />
            {t('replication.title', 'Replication')}
          </span>
        </CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>

      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t(
            'replication.description',
            'Keep This Bucket In Sync With Another WebDAV Server, On A Schedule. Changes Move In Both Directions.',
          )}
        </p>

        {unsupported ? (
          // Version skew, not a fault. A backend predating replication has no such
          // route and answers 404, which — because the settings tab already loaded
          // this bucket — cannot mean "not yours" or "gone". Say so, rather than
          // rendering an empty target list that reads as "you have none".
          <p className="text-sm text-[var(--color-text-muted)]">
            {t('replication.unsupported', 'This Backend Predates Replication. Update It To Configure Targets.')}
          </p>
        ) : (
          <>
            {rows.length > 0 ? (
              <ul className="space-y-3">
                {rows.map((replication) => (
                  <VolumeReplicationRow
                    key={replication.replicationId}
                    replication={replication}
                    busy={busyId === replication.replicationId}
                    onSyncNow={() => void syncNow(replication)}
                    onToggle={() => void toggle(replication)}
                    onShowDecisions={() => void loadConflicts(replication.replicationId)}
                    onRemove={() => setRemoving(replication)}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-[var(--color-text-muted)]">{t('replication.none', 'No Replication Targets Yet.')}</p>
            )}

            {conflictsFor !== null && (
              <VolumeReplicationDecisions
                conflicts={conflicts}
                onResolve={(conflict) => void resolve(conflict)}
                onDismiss={() => {
                  setConflicts([]);
                  setConflictsFor(null);
                }}
              />
            )}

            <VolumeReplicationForm
              owner={owner}
              volume={volume}
              intervals={intervals}
              showNotice={showNotice}
              onSaved={refresh}
              backend={backend}
            />
          </>
        )}
      </div>

      {removing !== null && (
        <ConfirmDeleteModal
          title={t('replication.removeTarget', 'Remove Replication Target')}
          displayName={removing.targetKind === 'dav-volume' ? `${removing.remoteOwner}/${removing.remoteVolume}` : removing.remoteUrl}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}