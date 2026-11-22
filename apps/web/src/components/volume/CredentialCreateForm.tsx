import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import type { CreatedBucketCredential } from '../../types';
import { createBucketCredential } from '../../services/credentialService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

/**
 * One create form, instantiated twice by `VolumeCredentialsCard` — once per
 * credential type. The single behavioural difference is that a server
 * credential has no expiry field and never sends an `expiresInDays`: the
 * backend mints it with a never-expiring sentinel instead. Two dedicated forms
 * and buttons are deliberate; a mode toggle leaves the owner unsure which type
 * a submit will mint.
 *
 * `server` and `backend` are separate arguments, in that order, because the
 * selector is the trailing argument throughout `credentialService`. A server
 * credential still has to carry the selector or it resolves to no backend.
 */
export function CredentialCreateForm({
  owner,
  volume,
  server,
  backend,
  showNotice,
  onCreated,
}: {
  owner: string;
  volume: string;
  server: boolean;
  backend?: string | null;
  showNotice: (kind: 'success' | 'error', message: string) => void;
  onCreated: (created: CreatedBucketCredential) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const expiry = expiresInDays.trim() === '' ? undefined : Number(expiresInDays);
    if (expiry !== undefined && (!Number.isSafeInteger(expiry) || expiry <= 0)) {
      showNotice('error', t('credentials.invalidExpiry', 'Expiry Must Be A Positive Number Of Days.'));
      return;
    }
    setSaving(true);
    try {
      const created = await createBucketCredential(owner, volume, name.trim(), server ? undefined : expiry, readOnly, server, backend);
      onCreated(created);
      setName('');
      setExpiresInDays('');
      setReadOnly(false);
      showNotice(
        'success',
        server
          ? t('credentials.createdServer', 'Server Credential Created. Copy The Password Now — It Will Not Be Shown Again.')
          : t('credentials.created', 'Credential Created. Copy The Password Now — It Will Not Be Shown Again.'),
      );
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateCredential', 'Failed To Create Credential.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-3 flex-wrap">
        <div className="flex-1 min-w-48">
          <Input
            placeholder={t('credentials.namePlaceholder', 'Credential Name (e.g. laptop)')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        {!server && (
          <div className="w-32">
            <Input
              placeholder={t('credentials.expiryPlaceholder', 'Expiry (days)')}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              inputMode="numeric"
            />
          </div>
        )}
        <label
          className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]"
          title={t('credentials.readOnlyHint', 'Can Browse And Download, But Cannot Upload, Delete, Or Rename.')}
        >
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          {t('credentials.readOnly', 'Read-Only')}
        </label>
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          <KeyRound className="h-3.5 w-3.5" />
          {server ? t('credentials.createServer', 'Create Server Credential') : t('credentials.create', 'Create Credential')}
        </Button>
      </div>
      {server && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('credentials.serverHint', 'Server Credentials Never Expire. Use Them For Long-Lived Servers And Automation.')}
        </p>
      )}
    </form>
  );
}
