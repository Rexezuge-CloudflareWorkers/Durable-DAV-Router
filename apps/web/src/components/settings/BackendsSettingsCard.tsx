import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pencil, Server } from 'lucide-react';
import { cn } from '@rexezuge/web';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { useAsyncLoad } from '../../hooks/useAsyncLoad';
import { deleteBackend, listBackends, probeBackend, updateBackend } from '../../services/backendService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { IconButton } from '../ui/IconButton';
import { SkeletonRows } from '../ui/Skeleton';
import { ConfirmDeleteModal } from '@rexezuge/web';

/**
 * The whole backend registry, and the only page that shows one.
 *
 * This card absorbed the dashboard's Backends section, so it carries both
 * halves: the registry edits (display name, delete) and the liveness view
 * (status, on-demand probe).
 */
export function BackendsSettingsCard({ showNotice }: { showNotice: (kind: 'success' | 'error', message: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [probing, setProbing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data: backends, loading, reload } = useAsyncLoad(listBackends, {
    onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadBackends', 'Failed To Load Backends.')),
  });
  const rows = backends ?? [];

  /**
   * Apply a change, then re-read.
   *
   * The re-read is what keeps the display name consistent with what the backend
   * stored; `updateBackend` returns the row, but a concurrent change from
   * another tab would be missed.
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

  const saveDisplayName = (slug: string) => {
    setEditingSlug(null);
    return change(() => updateBackend(slug, { displayName: draftName.trim() || null }), {
      doneKey: 'backends.updated',
      doneDefault: 'Backend Updated.',
      failedKey: 'errors.failedToUpdateBackend',
      failedDefault: 'Failed To Update Backend.',
    });
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
            {rows.map((b) => {
              const healthy = b.lastStatus !== null && b.lastStatus >= 200 && b.lastStatus < 400;
              return (
                <li
                  key={b.slug}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3 transition-colors duration-150 hover:border-[var(--color-surface-4)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {editingSlug === b.slug ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            autoFocus
                            aria-label={t('backends.displayName', 'Display Name')}
                            placeholder={t('backends.displayName', 'Display Name')}
                            value={draftName}
                            onChange={(event) => setDraftName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveDisplayName(b.slug);
                              else if (event.key === 'Escape') setEditingSlug(null);
                            }}
                            className="h-8 w-56 text-sm"
                          />
                          <Button variant="primary" size="sm" onClick={() => void saveDisplayName(b.slug)}>
                            {t('common.save', 'Save')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setEditingSlug(null)}>
                            {t('common.cancel', 'Cancel')}
                          </Button>
                        </div>
                      ) : (
                        <p className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                          {b.displayName ? `${b.displayName} (${b.slug})` : b.slug}
                        </p>
                      )}
                      <p className="mt-0.5 break-all font-mono text-xs text-[var(--color-text-muted)]">{b.baseUrl}</p>
                      {/*
                       * The cached last probe, not a live one.
                       *
                       * This used to read the `GET /user/volumes` fan-out, which is a
                       * real probe of every backend from Worker egress — one per
                       * settings page load, to render one line. `last_status` is what
                       * the last probe recorded and the Check button refreshes it, so
                       * the line is labelled as a last-seen answer rather than
                       * dressed up as a current one.
                       */}
                      <p
                        className={cn(
                          'mt-1.5 text-xs',
                          !b.lastStatus && 'text-[var(--color-text-muted)]',
                          b.lastStatus && healthy && 'text-[var(--color-success-text)]',
                          b.lastStatus && !healthy && 'text-[var(--color-error-text)]',
                        )}
                      >
                        {b.lastStatus ? `● ${b.lastStatus}` : t('backends.statusNeverProbed', '● Never Probed')}
                        {b.lastSeenAt
                          ? ` · ${t('backends.lastSeen', 'Last Seen {{when}}', {
                              when: new Date(b.lastSeenAt * 1000).toLocaleString(),
                            })}`
                          : null}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {editingSlug !== b.slug && (
                        <IconButton
                          label={t('common.edit', 'Edit')}
                          onClick={() => {
                            setEditingSlug(b.slug);
                            setDraftName(b.displayName ?? '');
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={probing === b.slug}
                        onClick={() => void check(b.slug)}
                      >
                        {probing === b.slug ? t('backends.probing', 'Checking…') : t('backends.probe', 'Check')}
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setConfirming(b.slug)}>
                        {t('common.delete', 'Delete')}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
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
