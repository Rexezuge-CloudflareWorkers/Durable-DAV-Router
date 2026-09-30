import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { useAsyncLoad } from '../../hooks/useAsyncLoad';
import { deleteBackend, listBackends, updateBackend } from '../../services/backendService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';

export function BackendsSettingsCard({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Record<string, string>>({});

  const { data: backends, loading, reload } = useAsyncLoad(listBackends, {
    onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadBackends', 'Failed To Load Backends.')),
  });
  const rows = backends ?? [];

  /**
   * Apply a change, then re-read.
   *
   * The re-read is what keeps the health badge and the display name consistent
   * with what the backend stored; `updateBackend` returns the row, but a
   * concurrent change from another tab would be missed.
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
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t('backends.empty', 'No Backends Registered.')}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((b) => (
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
