import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import type { RouterBackend } from '../types';
import { getBackendIdentity, listBackends } from '../services/backendService';
import { apiPost } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Input, Label } from '../components/ui/Input';
import { ContextBar } from '../components/layout/ContextBar';
import { AppPage } from '../components/layout/AppPage';

type OwnerState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; username: string }
  | { status: 'missing' }
  | { status: 'error' };

export function NewVolumeView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [backend, setBackend] = useState('');
  const [backends, setBackends] = useState<RouterBackend[]>([]);
  const [ownerState, setOwnerState] = useState<OwnerState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void listBackends()
      .then((rows) => {
        setBackends(rows);
        if (!(rows.length === 1 && rows[0])) {
          return;
        }

        setBackend(rows[0].slug);
        setOwnerState({ status: 'loading' });
      })
      .catch(() => undefined);
  }, []);

  // Usernames live on backends (same email may own different handles per
  // backend). Auto-load the handle for the selected backend; the owner
  // field is read-only and never manually editable. Loading/idle transitions
  // happen in event handlers; this effect only resolves the async fetch.
  useEffect(() => {
    if (!backend.trim()) return;
    let cancelled = false;
    void getBackendIdentity(backend.trim())
      .then((identity) => {
        if (cancelled) return;
        if (identity.username?.trim()) setOwnerState({ status: 'ready', username: identity.username.trim() });
        else setOwnerState({ status: 'missing' });
      })
      .catch(() => {
        if (cancelled) return;
        setOwnerState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  const handleBackendChange = (slug: string) => {
    setBackend(slug);
    setOwnerState(({ status: slug.trim() ? 'loading' : 'idle' }));
  };

  const ownerUsername = ownerState.status === 'ready' ? ownerState.username : '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backend.trim()) {
      showNotice('error', t('volumes.selectBackend', 'Select A Backend First.'));
      return;
    }
    if (ownerState.status !== 'ready') {
      showNotice('error', t('volumes.ownerNotReady', 'Backend Owner Is Not Ready Yet.'));
      return;
    }
    setSaving(true);
    try {
      const created = await apiPost<{ owner: string; name: string }>(
        `/user/volumes?backend=${encodeURIComponent(backend.trim())}`,
        { owner: ownerUsername, name: name.trim(), isPrivate },
      );
      showNotice('success', t('volumes.volumeCreated', 'Volume {{fullName}} Created.', { fullName: `${created.owner}/${created.name}` }));
      void navigate(`/${created.owner}/${created.name}?backend=${encodeURIComponent(backend.trim())}`);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateVolume', 'Failed To Create Volume.'));
    } finally {
      setSaving(false);
    }
  };

  const ownerPlaceholder =
    ownerState.status === 'loading'
      ? t('volumes.loadingOwner', 'Loading Owner…')
      : ownerState.status === 'missing'
        ? t('volumes.noUsernameOnBackend', 'No Username On This Backend Yet.')
        : ownerState.status === 'error'
          ? t('volumes.ownerLoadFailed', 'Failed To Load Owner.')
          : t('volumes.ownerAutoPlaceholder', 'Select A Backend First.');

  return (
    <div>
      <ContextBar
        crumb={<span className="text-xl font-semibold text-[var(--color-text-primary)] truncate">{t('volumes.newVolume', 'New Volume')}</span>}
      />
      <AppPage variant="narrow">
        <Card>
          <CardHeader>
            <CardTitle>{t('volumes.newVolume', 'New Volume')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label className="mb-1.5">{t('volumes.backend', 'Backend')}</Label>
              <select value={backend} onChange={(e) => handleBackendChange(e.target.value)} required className="w-full rounded border px-2 py-1.5 text-sm">
                <option value="">{t('volumes.chooseBackend', 'Choose A Backend')}</option>
                {backends.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.displayName ? `${b.displayName} (${b.slug})` : b.slug}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="mb-1.5">{t('volumes.owner', 'Owner')}</Label>
              <Input value={ownerUsername} placeholder={ownerPlaceholder} disabled readOnly required />
              {ownerState.status === 'missing' && (
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {t(
                    'volumes.noUsernameOnBackendHint',
                    'This Backend Has No Username For You Yet. Open The Backend And Set Your Username Before Creating Buckets.',
                  )}
                </p>
              )}
              {ownerState.status === 'error' && (
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {t('volumes.ownerLoadFailedHint', 'Could Not Reach The Backend Identity. Check The Backend Status And Retry.')}
                </p>
              )}
            </div>
            <div>
              <Label className="mb-1.5">{t('volumes.volumeName', 'Volume Name')}</Label>
              <Input
                placeholder={t('volumes.volumeNamePlaceholder', 'my-files')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
              {t('volumes.privateVolume', 'Private Volume')}
            </label>
            <Button type="submit" variant="primary" loading={saving} disabled={ownerState.status !== 'ready'}>
              {t('volumes.createVolume', 'Create Volume')}
            </Button>
          </form>
        </Card>
      </AppPage>
    </div>
  );
}
