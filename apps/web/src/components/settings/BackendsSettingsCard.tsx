import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { useAsyncLoad } from '../../hooks/useAsyncLoad';
import { deleteBackend, listBackends, probeBackend, updateBackend } from '../../services/backendService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

/**
 * The whole backend registry, and the only page that shows one.
 *
 * This card absorbed the dashboard's Backends section, so it carries both
 * halves: the registry edits (display name, delete) and the liveness view
 * (status, on-demand probe).
 */
export function BackendsSettingsCard({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Record<string, string>>({});
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

  const saveDisplayName = (slug: string) =>
    change(() => updateBackend(slug, { displayName: editing[slug]?.trim() ? editing[slug].trim() : null }), {
      doneKey: 'backends.updated',
      doneDefault: 'Backend Updated.',
      failedKey: 'errors.failedToUpdateBackend',
      failedDefault: 'Failed To Update Backend.',
    });

  const remove = (slug: string) =>
    change(() => deleteBackend(slug), { doneKey: 'backends.deleted', doneDefault: 'Backend Removed.', failedKey: 'errors.failedToDeleteBackend', failedDefault: 'Failed To Remove Backend.' });

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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <Server className="h-4 w-4" />
              {t('backends.title', 'Backends')}
            </span>
          </CardTitle>
          <span className="text-sm text-[var(--color-text-muted)]">{rows.length}</span>
        </CardHeader>
        {loading ? (
          <p className="text-sm text-[var(--color-text-secondary)]">{t('common.loading', 'Loading')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">{t('backends.empty', 'No Backends Registered.')}</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((b) => (
              <li key={b.slug} className="rounded border border-[var(--color-border)] p-3">
                <p className="text-sm font-medium">{b.displayName ? `${b.displayName} (${b.slug})` : b.slug}</p>
                <p className="text-xs text-[var(--color-text-muted)] break-all">{b.baseUrl}</p>
                {/*
                 * The cached last probe, not a live one.

                 * This used to read the `GET /user/volumes` fan-out, which is a
                 * real probe of every backend from Worker egress — one per
                 * settings page load, to render one line. `last_status` is what
                 * the last probe recorded and the Check button refreshes it, so
                 * the line is labelled as a last-seen answer rather than
                 * dressed up as a current one.
                 */}
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  {b.lastStatus
                    ? `● ${b.lastStatus}`
                    : t('backends.statusNeverProbed', '● Never Probed')}
                  {b.lastSeenAt
                    ? ` · ${t('backends.lastSeen', 'Last Seen {{when}}', {
                        when: new Date(b.lastSeenAt * 1000).toLocaleString(),
                      })}`
                    : null}
                </p>
                <div className="mt-2 flex gap-2 flex-wrap">
                  <Input
                    placeholder={t('backends.displayName', 'Display Name')}
                    value={editing[b.slug] ?? b.displayName ?? ''}
                    onChange={(e) => setEditing((m) => ({ ...m, [b.slug]: e.target.value }))}
                  />
                  <Button variant="secondary" size="sm" onClick={() => void saveDisplayName(b.slug)}>
                    {t('common.save', 'Save')}
                  </Button>
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
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void navigate('/backends/new')}>
            {t('backends.add', 'Add Backend')}
          </Button>
        </div>
      </Card>

      {confirming && (
        <ConfirmDeleteModal
          title={t('backends.title', 'Backends')}
          // The same label the row shows, so the dialog identifies the backend
          // by what the user is looking at rather than by a bare slug they may
          // have renamed away from.
          displayName={(() => {
            const row = rows.find((b) => b.slug === confirming);
            return row?.displayName ? `${row.displayName} (${row.slug})` : confirming;
          })()}
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