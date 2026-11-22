import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BucketCredential, CreatedBucketCredential } from '../../types';
import { useAsyncLoad } from '../../hooks/useAsyncLoad';
import { listBucketCredentials, revokeBucketCredential, setBucketCredentialReadOnly } from '../../services/credentialService';
import { formatExpiryTimestamp } from '../../lib/format';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { RefreshButton, ReadOnlyField, ConfirmDeleteModal } from '@rexezuge/web';
import { CredentialCreateForm } from './CredentialCreateForm';

export function VolumeCredentialsCard({
  owner,
  volume,
  showNotice,
  backend,
}: {
  owner: string;
  volume: string;
  showNotice: (kind: 'success' | 'error', message: string) => void;
  backend?: string | null;
}) {
  const { t } = useTranslation();
  const [lastCreated, setLastCreated] = useState<{ username: string; password: string; readOnly: boolean; isServer: boolean } | null>(null);
  const [revoking, setRevoking] = useState<BucketCredential | null>(null);
  const [flipping, setFlipping] = useState<string | null>(null);

  // The identity is a closure over `owner`/`volume`/`backend`, so it is read
  // through a ref by `useAsyncLoad` rather than being a dependency: a fresh
  // arrow on every render would re-fire the request on every render.
  const { data: credentials, loading, reload, patch: patchCredentials } = useAsyncLoad(
    () => listBucketCredentials(owner, volume, backend),
    {
      reloadKey: `${owner}\u{0}${volume}\u{0}${backend ?? ''}`,
      onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadCredentials', 'Failed To Load Credentials.')),
    },
  );
  const refresh = reload;
  // `undefined` is "not loaded yet", which renders exactly as an empty list did;
  // naming it once keeps every `credentials?.` out of the markup.
  const rows = credentials ?? [];

  // Both create forms share the copy-once reveal and the refresh. The flag is
  // echoed from the backend's answer, so the badge reflects what was minted and
  // not which form the owner happened to submit.
  const handleCreated = (created: CreatedBucketCredential) => {
    setLastCreated({ username: created.username, password: created.password, readOnly: created.readOnly, isServer: created.isServer });
    reload();
  };

  /**
Flip a credential between read-only and full access.

Optimistic: the row is patched locally first so the badge does not lag a network
round trip, and reverted from the server's answer on failure. The credential is
a bearer secret the client has already cached, so the backend cannot force the
client to forget it — this toggle is a policy statement that takes effect on
the next request the client makes.
*/
const toggleReadOnly = async (cred: BucketCredential) => {
    const next = !cred.readOnly;
    setFlipping(cred.credentialId);
    // Optimistic: the row is patched first so the badge does not lag a network
    // round trip, and reverted from the server's answer on failure. The
    // credential is a bearer secret the client has already cached, so the backend
    // cannot make the client forget it — this is a policy statement that takes
    // effect on the next request the client makes, and showing the user's own
    // intent immediately is the honest rendering of that.
    const flip = (readOnly: boolean): void => {
      patchCredentials((rows) => rows.map((row) => (row.credentialId === cred.credentialId ? { ...row, readOnly } : row)));
    };
    flip(next);
    try {
      await setBucketCredentialReadOnly(owner, volume, cred.credentialId, next, backend);
      showNotice('success', next ? t('credentials.nowReadOnly', 'Credential Is Now Read-Only.') : t('credentials.nowReadWrite', 'Credential Can Now Write.'));
    } catch (error) {
      flip(cred.readOnly);
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateCredential', 'Failed To Update Credential.'));
    } finally {
      setFlipping(null);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revokeBucketCredential(owner, volume, revoking.credentialId, backend);
      showNotice('success', t('credentials.revoked', 'Credential Revoked.'));
      reload();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToRevokeCredential', 'Failed To Revoke Credential.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('credentials.bucketCredentials', 'Bucket Credentials')}</CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} label={t('common.refresh', 'Refresh')} />
      </CardHeader>
      <p className="text-sm text-[var(--color-text-secondary)] mb-3">
        {t('credentials.hint', 'Each Credential Unlocks Only This Bucket. Use The Generated Username And Password As WebDAV Basic Auth.')}
      </p>
      <div className="space-y-3">
        <CredentialCreateForm owner={owner} volume={volume} server={false} backend={backend} showNotice={showNotice} onCreated={handleCreated} />
        <div className="border-t border-[var(--color-border)] pt-3 space-y-2">
          <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('credentials.serverTitle', 'Server Credentials')}</p>
          <CredentialCreateForm owner={owner} volume={volume} server backend={backend} showNotice={showNotice} onCreated={handleCreated} />
        </div>
      </div>
      {lastCreated && (
        <div className="mt-4 space-y-2">
          <ReadOnlyField label={t('credentials.newUsername', 'New Username')} value={lastCreated.username} showCopy copyLabel={t('common.copyToClipboard', 'Copy To Clipboard')} />
          <ReadOnlyField label={t('credentials.newPassword', 'New Password (Copy Once)')} value={lastCreated.password} showCopy copyLabel={t('common.copyToClipboard', 'Copy To Clipboard')} />
          {lastCreated.isServer && <Badge variant="info">{t('credentials.serverBadge', 'Server Credential · Never Expires')}</Badge>}
          {lastCreated.readOnly && <Badge variant="info">{t('credentials.readOnlyBadge', 'Read-Only Access')}</Badge>}
        </div>
      )}
      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {rows.map((cred) => (
          <li key={cred.credentialId} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="font-medium text-[var(--color-text-primary)] truncate">
                {cred.name}
                <span className="ml-2 font-mono text-xs text-[var(--color-text-muted)]">
                  {cred.username} · {cred.passwordPrefix}…{cred.passwordLastFour}
                </span>
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {cred.isServer ? t('credentials.serverBadge', 'Server Credential · Never Expires') : formatExpiryTimestamp(cred.expiresAt)}
                {cred.readOnly && <span className="ml-2">{t('credentials.readOnlyBadge', 'Read-Only Access')}</span>}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="secondary" size="sm" loading={flipping === cred.credentialId} onClick={() => void toggleReadOnly(cred)}>
                {cred.readOnly ? t('credentials.allowWrites', 'Allow Writes') : t('credentials.makeReadOnly', 'Make Read-Only')}
              </Button>
              <Button variant="danger" size="sm" onClick={() => setRevoking(cred)}>
                {t('credentials.revoke', 'Revoke')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {(credentials?.length ?? 0) === 0 && !loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('credentials.empty', 'No Credentials Yet.')}</p>
      )}
      {revoking && (
        <ConfirmDeleteModal
          ariaLabel={t('credentials.revokeCredential', 'Revoke Credential')}
          message={t('common.deleteConfirm', 'Delete {{name}}? This Cannot Be Undone.', { name: revoking.name })}
          confirmLabel={t('common.delete', 'Delete')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </Card>
  );
}
