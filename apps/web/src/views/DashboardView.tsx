import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FolderArchive, LayoutGrid, Lock, Plus, Search, Server } from 'lucide-react';
import type { AggregatedVolume } from '../types';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { listMyVolumes } from '../services/volumeService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { SkeletonRows } from '../components/ui/Skeleton';
import { VisibilityBadge } from '../components/ui/Badge';
import { AppPage, PageHeaderCard, EmptyState, RefreshButton } from '@rexezuge/web';

export function DashboardView({ showNotice }: { showNotice: (kind: 'success' | 'error', message: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

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
    onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadVolumes', 'Failed To Load Buckets.')),
  });

  const volumes = useMemo(() => data?.volumes ?? [], [data]);
  const refresh = reload;

  /**
   * Buckets bucketed by the backend that holds them.
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

  /**
  Client-side filter over the one response this page already has.
  */
  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...grouped];
    const matches = (v: AggregatedVolume) => v.fullName.toLowerCase().includes(needle) || (v.description ?? '').toLowerCase().includes(needle);
    return [...grouped]
      .map(([slug, rows]) => [slug, rows.filter(matches)] as const)
      .filter(([, rows]) => rows.length > 0);
  }, [grouped, query]);

  const privateCount = volumes.filter((v) => v.isPrivate).length;
  const hasBuckets = volumes.length > 0;

  return (
    <AppPage>
      <PageHeaderCard
        icon={<LayoutGrid className="h-5 w-5 text-[var(--color-accent)]" />}
        title={t('dashboard.title', 'Dashboard')}
        description={t('dashboard.subtitle', 'Every Bucket, Grouped By The Backend That Holds It.')}
        actions={
          <>
            <RefreshButton onRefresh={refresh} loading={loading} label={t('common.refresh', 'Refresh')} />
            <Button variant="primary" size="sm" onClick={() => void navigate('/new')}>
              <Plus className="h-3.5 w-3.5" />
              {t('dashboard.new', 'New')}
            </Button>
          </>
        }
      />

      {hasBuckets && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat icon={<FolderArchive className="h-4 w-4" />} label={t('dashboard.statsBuckets', 'Buckets')} value={volumes.length} />
          <Stat icon={<Server className="h-4 w-4" />} label={t('dashboard.statsBackends', 'Backends')} value={grouped.size} />
          <Stat icon={<Lock className="h-4 w-4" />} label={t('dashboard.statsPrivate', 'Private')} value={privateCount} />
        </div>
      )}

      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle className="inline-flex items-center gap-2">
            <FolderArchive className="h-4 w-4 text-[var(--color-text-secondary)]" />
            {t('dashboard.volumes', 'Buckets')}
            <span className="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 text-xs font-medium tabular-nums text-[var(--color-text-secondary)]">
              {volumes.length}
            </span>
          </CardTitle>
          {hasBuckets && (
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('dashboard.searchPlaceholder', 'Search Buckets…')}
                aria-label={t('dashboard.searchPlaceholder', 'Search Buckets…')}
                className="pl-8 text-xs"
              />
            </div>
          )}
        </CardHeader>

        {loading && !data ? (
          <SkeletonRows count={4} />
        ) : volumes.length === 0 ? (
          <EmptyState
            icon={<FolderArchive className="h-6 w-6 text-[var(--color-text-muted)]" />}
            message={
              <>
                {t('dashboard.empty', 'No Buckets Yet. Register A Backend First.')}{' '}
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
        ) : filteredGroups.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-text-secondary)]">{t('dashboard.noMatches', 'No Buckets Match Your Search.')}</p>
        ) : (
          <div className="space-y-6">
            {filteredGroups.map(([slug, rows]) => (
              <section key={slug} aria-label={slug}>
                <div className="mb-2.5 flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{slug}</h3>
                  <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{rows.length}</span>
                  <span className="h-px flex-1 bg-[var(--color-border)]" />
                </div>
                <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {rows.map((v) => (
                    <li key={`${v.backend}/${v.fullName}`}>
                      <Link
                        to={`/${v.owner}/${v.name}?backend=${encodeURIComponent(v.backend)}`}
                        className="group flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3 transition-colors duration-150 hover:border-[var(--color-surface-4)] hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-4)] text-[var(--color-accent)]">
                          <FolderArchive className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{v.fullName}</span>
                          <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">
                            {v.description?.trim() || t('dashboard.bucketFallback', 'WebDAV Bucket')}
                          </span>
                        </span>
                        <VisibilityBadge isPrivate={v.isPrivate} />
                        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 group-hover:translate-x-0.5" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>
    </AppPage>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-tight tabular-nums text-[var(--color-text-primary)]">{value}</p>
        <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      </div>
    </div>
  );
}
