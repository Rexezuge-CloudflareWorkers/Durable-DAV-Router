import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderPlus, Loader2 } from 'lucide-react';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { getBackendIdentity, listBackends } from '../services/backendService';
import { apiPost } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Checkbox, FieldHint, Input, Label, Select } from '../components/ui/Input';
import { BreadcrumbBar } from '../components/layout/BreadcrumbBar';
import { AppPage, PageHeaderCard } from '@rexezuge/web';

type OwnerState =
  { status: 'idle' } | { status: 'loading' } | { status: 'ready'; username: string } | { status: 'missing' } | { status: 'error' };

export function NewVolumeView({ showNotice }: { showNotice: (kind: 'success' | 'error', message: string) => void }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [ownerState, setOwnerState] = useState<OwnerState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);

  /**
   * The backend list, and with it a preselection when there is only one.
   *
   * A failure is silent by design: the page's whole purpose is to create a bucket
   * on a backend, and with the list empty the form already says "select a backend
   * first". An error banner on top of that would describe a problem the user
   * cannot act on from this page.
   */
  const { data: backends } = useAsyncLoad(listBackends, { onError: () => undefined });
  const rows = backends ?? [];

  /**
   * The selected backend, derived rather than stored.
   *
   * Only auto-selected when the list resolves to exactly one — more than one and
   * the choice is the user's, none and there is nothing to pick. Deriving it
   * during render instead of pushing it into an effect keeps the selection and
   * the list from ever disagreeing: an effect that fired on the list would also
   * fire on the user's own choice and fight it.
   */
  const backend = chosen ?? (rows.length === 1 ? (rows[0]?.slug ?? '') : '');

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
        const username = identity.username?.trim();
        setOwnerState(username ? { status: 'ready', username } : { status: 'missing' });
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
    setChosen(slug);
    setOwnerState({ status: slug.trim() ? 'loading' : 'idle' });
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
      const created = await apiPost<{ owner: string; name: string }>(`/user/volumes?backend=${encodeURIComponent(backend.trim())}`, {
        owner: ownerUsername,
        name: name.trim(),
        isPrivate,
      });
      showNotice('success', t('volumes.volumeCreated', 'Bucket {{fullName}} Created.', { fullName: `${created.owner}/${created.name}` }));
      void navigate(`/${created.owner}/${created.name}?backend=${encodeURIComponent(backend.trim())}`);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateVolume', 'Failed To Create Bucket.'));
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
      <BreadcrumbBar crumb={<span className="truncate">{t('volumes.newVolume', 'New Bucket')}</span>} />
      <AppPage variant="narrow">
        <PageHeaderCard
          icon={<FolderPlus className="h-5 w-5 text-[var(--color-accent)]" />}
          title={t('volumes.newVolume', 'New Bucket')}
          description={t('volumes.newVolumeSubtitle', 'A Bucket Is One WebDAV Collection, Backed By Its Own Durable Object.')}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('volumes.details', 'Details')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-volume-backend">{t('volumes.backend', 'Backend')}</Label>
              <Select
                id="new-volume-backend"
                value={backend}
                onChange={(e) => handleBackendChange(e.target.value)}
                required
                className="w-full"
              >
                <option value="">{t('volumes.chooseBackend', 'Choose A Backend')}</option>
                {(backends ?? []).map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.displayName ? `${b.displayName} (${b.slug})` : b.slug}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-volume-owner">{t('volumes.owner', 'Owner')}</Label>
              <div className="relative">
                <Input
                  id="new-volume-owner"
                  value={ownerUsername}
                  placeholder={ownerPlaceholder}
                  disabled
                  readOnly
                  required
                  className={ownerState.status === 'loading' ? 'pr-10' : undefined}
                />
                {ownerState.status === 'loading' && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--color-text-muted)]" />
                )}
              </div>
              <FieldHint>
                {t('volumes.ownerHint', 'Your Username On The Selected Backend, Loaded Automatically And Read-Only Here.')}
              </FieldHint>
              {ownerState.status === 'missing' && (
                <p className="mt-1 text-xs text-[var(--color-warning-text)]">
                  {t(
                    'volumes.noUsernameOnBackendHint',
                    'This Backend Has No Username For You Yet. Open The Backend And Set Your Username Before Creating Buckets.',
                  )}
                </p>
              )}
              {ownerState.status === 'error' && (
                <p className="mt-1 text-xs text-[var(--color-error-text)]">
                  {t('volumes.ownerLoadFailedHint', 'Could Not Reach The Backend Identity. Check The Backend Status And Retry.')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-volume-name">{t('volumes.volumeName', 'Bucket Name')}</Label>
              <Input
                id="new-volume-name"
                placeholder={t('volumes.volumeNamePlaceholder', 'my-files')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              <FieldHint>{t('volumes.nameHint', 'Letters, Numbers, Dashes And Underscores.')}</FieldHint>
            </div>
            <Checkbox
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              label={t('volumes.privateVolume', 'Private Bucket')}
              hint={t('volumes.privateHint', 'Private Buckets Require A Credential. Public Buckets Allow Anonymous Reads.')}
            />
            <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
              <Button type="submit" variant="primary" loading={saving} disabled={ownerState.status !== 'ready'}>
                {t('volumes.createVolume', 'Create Bucket')}
              </Button>
            </div>
          </form>
        </Card>
      </AppPage>
    </div>
  );
}
