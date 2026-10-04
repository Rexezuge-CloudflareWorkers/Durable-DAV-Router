import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderArchive, Plus } from 'lucide-react';
import type { AggregatedVolume } from '../types';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { listMyVolumes } from '../services/volumeService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { AppPage } from '../components/layout/AppPage';
import { PageHeaderCard } from '../components/layout/PageHeaderCard';
import { EmptyState } from '../components/layout/PageState';
import { VisibilityBadge } from '../components/ui/Badge';
import { ReadOnlyField } from '../components/shared/ReadOnlyField';
import { RefreshButton } from '../components/shared/RefreshButton';

export function DashboardView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  /**
   * The buckets, grouped by the backend that holds them.
   *
   * One request. The backend registry lives in `/settings`, so this is no
   * longer a two-request pair with a fail-soft second half — the `.catch()`
   * that kept a dead `/user/backends` from blanking the buckets has nothing
   * left to guard, and the fan-out health badges that needed it moved with the
   * registry.
   *
   * `useAsyncLoad` carries the cancellation guard. This effect had none for its
   * whole life, which made it the one load effect of seven without one:
   * StrictMode's double-invoked mount effects, and any refresh overlapping a
   * slow request, left the *superseded* response winning — the dashboard
   * showing pre-refresh buckets with no spinner and no error.
   */
  const { data, loading, reload } = useAsyncLoad(listMyVolumes, {
    onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadVolumes', 'Failed To Load Volumes.')),
  });

  const volumes = data?.volumes ?? [];
  const refresh = reload;

  /**
   * Volumes bucketed by the backend that holds them.
   *
   * Memoised because it is a pure derivation of `volumes`: without it, an
   * unrelated re-render — a notice appearing, a probe finishing — rebuilds the
   * map and hands every row a new array, re-rendering the whole dashboard for no
   * change in what it shows.
   */
  const grouped = useMemo(
    () =>
      // eslint-disable-next-line unicorn/prefer-group-by -- target ES2021 has no Map.groupBy.
      volumes.reduce((acc, v) => {
        const key = v.backend ?? 'unknown';
        const list = acc.get(key) ?? [];
        list.push(v);
        acc.set(key, list);
        return acc;
      }, new Map<string, AggregatedVolume[]>()),
    [volumes],
  );

  return (
    <AppPage>
      <PageHeaderCard
        title={t('dashboard.title', 'Dashboard')}
        actions={
          <>
            <RefreshButton onRefresh={refresh} loading={loading} />
            <Button variant="primary" size="sm" onClick={() => void navigate('/new')}>
              <Plus className="h-3.5 w-3.5" />
              {t('dashboard.new', 'New')}
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.connect', 'Connect')}</CardTitle>
        </CardHeader>
        <div className="space-y-3">
          <ReadOnlyField
            label={t('dashboard.mountAnyVolume', 'Mount Any Volume')}
            value={`${globalThis.location?.origin ?? ''}/<owner>/<volume>/?backend=<slug>`}
            showCopy
          />
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t(
              'dashboard.connectHelp',
              'Each Bucket Lives On One Backend. Open A Bucket, Go To Settings, Create A Credential On That Backend, Then Connect With: {{example}}.',
              {
                example: 'https://<username>:<password>@backend-host/owner/volume/',
              },
            )}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.volumes', 'Volumes')}</CardTitle>
          <span className="text-sm text-[var(--color-text-muted)]">{volumes.length}</span>
        </CardHeader>
        {!loading && volumes.length === 0 ? (
          <EmptyState
            icon={<FolderArchive className="h-6 w-6 text-[var(--color-text-muted)]" />}
            message={
              <>
                {t('dashboard.empty', 'No Volumes Yet. Register A Backend First.')}{' '}
                {/*
                 * The first-run path to a backend, now that the registry moved
                 * to `/settings`. Unconditional rather than shown only when the
                 * registry is empty: deciding that would need the backend list
                 * back on this page, which is the request this move exists to
                 * stop making.
                 */}
                <Link to="/settings" className="text-[var(--color-accent)] hover:underline">
                  {t('dashboard.manageBackends', 'Manage Backends')}
                </Link>
              </>
            }
          />
        ) : (
          <div className="space-y-4">
            {[...grouped].map(([slug, rows]) => (
              <div key={slug}>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">{slug}</p>
                <ul className="divide-y divide-[var(--color-border)]">
                  {rows.map((v) => (
                    <li key={`${v.backend}/${v.fullName}`} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <Link
                          to={`/${v.owner}/${v.name}?backend=${encodeURIComponent(v.backend)}`}
                          className="font-medium text-[var(--color-accent)] hover:underline truncate"
                        >
                          {v.fullName}
                        </Link>
                      </div>
                      <VisibilityBadge isPrivate={v.isPrivate} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
    </AppPage>
  );
}
