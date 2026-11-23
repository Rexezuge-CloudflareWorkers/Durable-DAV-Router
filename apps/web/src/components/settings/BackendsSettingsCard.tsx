import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Server } from 'lucide-react';
import { ConfirmDeleteModal } from '@rexezuge/web';
import type { RouterBackend } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { groupBackends } from '../../lib/backendGroups';
import { useAsyncLoad } from '../../hooks/useAsyncLoad';
import { deleteBackend, listBackends, probeBackend, updateBackend } from '../../services/backendService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { SkeletonRows } from '../ui/Skeleton';
import { BackendRow } from './BackendRow';

/**
 * The whole backend registry, and the only page that shows one.
 *
 * This card absorbed the dashboard's Backends section, so it carries both
 * halves: the registry edits (display name, delete) and the liveness view
 * (status, on-demand probe). It now also groups a live backend with the
 * replicas that point at it: the live row stays visible and the replicas are
 * behind an expander. That is presentation only — every replica is still a
 * fully functional row with its own Check and Delete.
 */
export function BackendsSettingsCard({ showNotice }: { showNotice: (kind: 'success' | 'error', message: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftReplicaOf, setDraftReplicaOf] = useState('');
  const [probing, setProbing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const { data: backends, loading, reload } = useAsyncLoad(listBackends, {
    onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadBackends', 'Failed To Load Backends.')),
  });
  const rows = backends ?? [];

  const grouping = useMemo(() => groupBackends(rows), [rows]);
  const childrenBySlug = useMemo(
    () => new Map(grouping.groups.map((group) => [group.live.slug.toLowerCase(), group.replicas.length])),
    [grouping],
  );
  // Only live backends can be a replica's parent. Excluding replicas as well as
  // the row itself means the select never offers a choice the service would
  // reject (self-reference and chains are both 409s).
  const replicaOptions = useMemo(
    () =>
      grouping.groups.map((group) => ({
        slug: group.live.slug,
        label: group.live.displayName ? `${group.live.displayName} (${group.live.slug})` : group.live.slug,
      })),
    [grouping],
  );

  /**
   * Apply a change, then re-read.
   *
   * The re-read is what keeps the rows consistent with what the backend stored;
   * an update returns the row, but a concurrent change from another tab would be
   * missed. A live backend's replicas are promoted server-side on delete, so the
   * same re-read is what turns them into live rows here.
   */
  const change = useCallback(
    async (action: () => Promise<unknown>, messages: { doneKey: string; doneDefault: string; failedKey: string; failedDefault: string }) => {
      try {
        await action();
        showNotice('success', t(messages.doneKey, messages.doneDefault));
        reload();
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, messages.failedKey, messages.failedDefault));
      }
    },
    [reload, showNotice, t],
  );

  const save = (slug: string) => {
    setEditingSlug(null);
    return change(
      () => updateBackend(slug, { displayName: draftName.trim() || null, replicaOf: draftReplicaOf || null }),
      {
        doneKey: 'backends.updated',
        doneDefault: 'Backend Updated.',
        failedKey: 'errors.failedToUpdateBackend',
        failedDefault: 'Failed To Update Backend.',
      },
    );
  };

  const remove = (slug: string) =>
    change(() => deleteBackend(slug), {
      doneKey: 'backends.deleted',
      doneDefault: 'Backend Removed.',
      failedKey: 'errors.failedToDeleteBackend',
      failedDefault: 'Failed To Remove Backend.',
    });

  /**
   * One origin probe, on demand.
   *
   * `GET /user/backends/:slug/probe` also writes `last_status`/`last_seen_at`
   * through `recordProbe`, so the re-read is what makes this row's own status
   * line reflect the probe — without it the notice reports a fresh answer while
   * the row underneath still shows the old one.
   */
  const check = async (slug: string) => {
    setProbing(slug);
    try {
      const result = await probeBackend(slug);
      showNotice(
        'success',
        t('backends.probeResult', 'Probe {{slug}}: Health {{health}} Volumes {{volumes}}.', {
          slug: result.slug,
          health: result.health.status ?? result.health.error ?? '?',
          volumes: result.volumes.status ?? result.volumes.error ?? '?',
        }),
      );
      reload();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToProbe', 'Failed To Probe Backend.'));
    } finally {
      setProbing(null);
    }
  };

  const toggle = (slug: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const renderRow = (backend: RouterBackend, isReplica: boolean) => (
    <BackendRow
      key={backend.slug}
      backend={backend}
      isReplica={isReplica}
      editing={editingSlug === backend.slug}
      draftName={draftName}
      draftReplicaOf={draftReplicaOf}
      probing={probing === backend.slug}
      replicaOptions={replicaOptions.filter((option) => option.slug !== backend.slug)}
      canBeReplica={(childrenBySlug.get(backend.slug.toLowerCase()) ?? 0) === 0}
      onDraftNameChange={setDraftName}
      onDraftReplicaOfChange={setDraftReplicaOf}
      onStartEdit={() => setEditingSlug(backend.slug)}
      onCancelEdit={() => setEditingSlug(null)}
      onSave={() => void save(backend.slug)}
      onCheck={() => void check(backend.slug)}
      onDelete={() => setConfirming(backend.slug)}
    />
  );

  const confirmingRow = rows.find((b) => b.slug === confirming);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <Server className="h-4 w-4 text-[var(--color-text-secondary)]" />
              {t('backends.title', 'Backends')}
              <span className="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 text-xs font-medium tabular-nums text-[var(--color-text-secondary)]">
                {rows.length}
              </span>
            </span>
          </CardTitle>
          <Button variant="secondary" size="sm" onClick={() => void navigate('/backends/new')}>
            {t('backends.add', 'Add Backend')}
          </Button>
        </CardHeader>

        {loading && rows.length === 0 ? (
          <SkeletonRows count={2} />
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-text-secondary)]">
            {t('backends.empty', 'No Backends Registered.')}
          </p>
        ) : (
          <ul className="space-y-2.5">
            {grouping.groups.map((group) => {
              const count = group.replicas.length;
              const isExpanded = expanded.has(group.live.slug);
              return (
                <li key={group.live.slug} className="space-y-2.5">
                  <ul className="space-y-2.5">{renderRow(group.live, false)}</ul>
                  {count > 0 && (
                    <div className="ml-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={isExpanded}
                        aria-controls={`replicas-${group.live.slug}`}
                        onClick={() => toggle(group.live.slug)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        {t('backends.replicas', 'Replicas ({{count}})', { count })}
                      </Button>
                      {isExpanded && (
                        <ul id={`replicas-${group.live.slug}`} className="mt-2 space-y-2.5">
                          {group.replicas.map((replica) => renderRow(replica, true))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {grouping.orphans.map((orphan) => (
              <li key={orphan.slug}>
                <ul className="space-y-2.5">{renderRow(orphan, true)}</ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {confirming && (
        <ConfirmDeleteModal
          ariaLabel={t('backends.title', 'Backends')}
          // The same label the row shows, so the dialog identifies the backend
          // by what the user is looking at rather than by a bare slug they may
          // have renamed away from.
          message={t('common.deleteConfirm', 'Delete {{name}}? This Cannot Be Undone.', {
            name: confirmingRow?.displayName ? `${confirmingRow.displayName} (${confirmingRow.slug})` : confirming,
          })}
          confirmLabel={t('common.delete', 'Delete')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={() => {
            const slug = confirming;
            setConfirming(null);
            void remove(slug);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}
