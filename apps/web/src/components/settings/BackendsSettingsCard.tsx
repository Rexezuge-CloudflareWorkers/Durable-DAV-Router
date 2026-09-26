import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import type { RouterBackend } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { deleteBackend, listBackends, updateBackend } from '../../services/backendService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';

export function BackendsSettingsCard({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [backends, setBackends] = useState<RouterBackend[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setBackends(await listBackends());
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadBackends', 'Failed To Load Backends.'));
    } finally {
      setLoading(false);
    }
  }, [showNotice, t]);

  useEffect(() => {
    let cancelled = false;
    void listBackends()
      .then((rows) => {
        if (!cancelled) setBackends(rows);
      })
      .catch((error: unknown) => {
        if (!cancelled) showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadBackends', 'Failed To Load Backends.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showNotice, t]);

  const saveDisplayName = async (slug: string) => {
    try {
      await updateBackend(slug, { displayName: editing[slug]?.trim() ? editing[slug].trim() : null });
      showNotice('success', t('backends.updated', 'Backend Updated.'));
      await reload();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateBackend', 'Failed To Update Backend.'));
    }
  };

  const remove = async (slug: string) => {
    try {
      await deleteBackend(slug);
      showNotice('success', t('backends.deleted', 'Backend Removed.'));
      await reload();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDeleteBackend', 'Failed To Remove Backend.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <Server className="h-4 w-4" />
            {t('backends.title', 'Backends')}
          </span>
        </CardTitle>
      </CardHeader>
      {loading ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t('common.loading', 'Loading')}</p>
      ) : backends.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t('backends.empty', 'No Backends Registered.')}</p>
      ) : (
        <ul className="space-y-3">
          {backends.map((b) => (
            <li key={b.slug} className="rounded border border-[var(--color-border)] p-3">
              <p className="text-sm font-medium">{b.displayName ? `${b.displayName} (${b.slug})` : b.slug}</p>
              <p className="text-xs text-[var(--color-text-muted)] break-all">{b.baseUrl}</p>
              <div className="mt-2 flex gap-2 flex-wrap">
                <Input
                  placeholder={t('backends.displayName', 'Display Name')}
                  value={editing[b.slug] ?? b.displayName ?? ''}
                  onChange={(e) => setEditing((m) => ({ ...m, [b.slug]: e.target.value }))}
                />
                <Button variant="secondary" size="sm" onClick={() => void saveDisplayName(b.slug)}>
                  {t('common.save', 'Save')}
                </Button>
                <Button variant="danger" size="sm" onClick={() => void remove(b.slug)}>
                  {t('common.delete', 'Delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
