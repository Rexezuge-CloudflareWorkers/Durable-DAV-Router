import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderArchive, Plus, Server } from 'lucide-react';
import type { AggregatedVolume, BackendHealth, RouterBackend } from '../types';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { listMyVolumes } from '../services/volumeService';
import { listBackends } from '../services/backendService';
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
  const [volumes, setVolumes] = useState<AggregatedVolume[]>([]);
  const [backends, setBackends] = useState<RouterBackend[]>([]);
  const [health, setHealth] = useState<BackendHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const run = async () => {
      try {
        const [volRes, backendRows] = await Promise.all([listMyVolumes(), listBackends().catch(() => [])]);
        setVolumes(volRes.volumes);
        setHealth(volRes.backends);
        setBackends(backendRows);
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadVolumes', 'Failed To Load Volumes.'));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [showNotice, reloadKey, t]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  // eslint-disable-next-line unicorn/prefer-group-by -- target ES2021 has no Map.groupBy.
  const grouped = volumes.reduce((acc, v) => {
    const key = v.backend ?? 'unknown';
    const list = acc.get(key) ?? [];
    list.push(v);
    acc.set(key, list);
    return acc;
  }, new Map<string, AggregatedVolume[]>());

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
          <ReadOnlyField label={t('dashboard.mountAnyVolume', 'Mount Any Volume')} value={`${globalThis.location?.origin ?? ''}/<owner>/<volume>/?backend=<slug>`} showCopy />
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('dashboard.connectHelp', 'Each Bucket Lives On One Backend. Open A Bucket, Go To Settings, Create A Credential On That Backend, Then Connect With: {{example}}.', {
              example: 'https://<username>:<password>@backend-host/owner/volume/',
            })}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.backends', 'Backends')}</CardTitle>
          <span className="text-sm text-[var(--color-text-muted)]">{backends.length}</span>
        </CardHeader>
        {!loading && backends.length === 0 ? (
          <EmptyState
            icon={<Server className="h-6 w-6 text-[var(--color-text-muted)]" />}
            message={t('dashboard.noBackends', 'No Backends Yet. Register A Durable-DAV Instance To Get Started.')}
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {backends.map((b) => {
              const h = health.find((x) => x.slug === b.slug);
              return (
                <li key={b.slug} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{b.displayName ? `${b.displayName} (${b.slug})` : b.slug}</p>
                    <p className="text-xs text-[var(--color-text-muted)] truncate">{b.baseUrl}</p>
                  </div>
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {h ? (h.ok ? '● ok' : `● ${h.error ?? h.status ?? 'unreachable'}`) : b.lastStatus ? `● ${b.lastStatus}` : '● unknown'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void navigate('/backends/new')}>
            {t('dashboard.addBackend', 'Add Backend')}
          </Button>
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
            message={t('dashboard.empty', 'No Volumes Yet. Register A Backend First.')}
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
                        <Link to={`/${v.owner}/${v.name}?backend=${encodeURIComponent(v.backend)}`} className="font-medium text-[var(--color-accent)] hover:underline truncate">
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
