import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VolumeDetail } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { useAsyncLoad } from '../../hooks/useAsyncLoad';
import { loadVolume, updateVolume, deleteVolume } from '../../services/volumeService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Label, Textarea } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { TypeToConfirmModal } from '../modals/TypeToConfirmModal';
import { VolumeCredentialsCard } from './VolumeCredentialsCard';
import { HrefPrefixModeCard } from './HrefPrefixModeCard';
import { VolumeReplicationCard } from './VolumeReplicationCard';

export function VolumeSettingsTab({
  owner,
  volume,
  showNotice,
  onUpdated,
  onDeleted,
  backend,
}: {
  owner: string;
  volume: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onUpdated: (detail: VolumeDetail) => void;
  onDeleted: () => void;
  backend?: string | null;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingVisibility, setConfirmingVisibility] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);

  /**
   * The parent's breadcrumb is kept in step with what this tab loads.
   *
   * `onUpdated` is called from inside the loader rather than from a second effect:
   * a parent that passes an inline arrow re-renders on every state change, and
   * when `onUpdated` was an effect dependency that re-fetched the bucket on each
   * of those. `useAsyncLoad` reads its loader as an effect event, so closing over
   * `onUpdated` costs no extra request and needs no ref to hold it.
   */
  const {
    data: detail,
    loading,
    patch: patchDetail,
    reload,
  } = useAsyncLoad(async () => {
    const loaded = await loadVolume(owner, volume, backend);
    onUpdated(loaded);
    return loaded;
  }, {
    reloadKey: `${owner}\u{0}${volume}\u{0}${backend ?? ''}`,
    onError: (error) => showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadVolumes', 'Failed To Load Volumes.')),
  });

  const dirty = detail !== undefined && description.trim() !== (detail.description ?? '');

  /**
  Discard local edits, and re-read in case the stored value moved underneath us.
  */
  const reset = () => {
    setDescription(detail?.description ?? '');
    reload();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await updateVolume(
        owner,
        volume,
        {
          description: description.trim() === '' ? null : description.trim(),
        },
        backend,
      );
      // Patch the loaded value rather than re-reading: `updateVolume` returns the
      // authoritative row, so a second GET would only add a round trip and a
      // window in which the form shows stale text.
      patchDetail(() => updated);
      onUpdated(updated);
      showNotice('success', t('volumes.settingsUpdated', 'Bucket Settings Updated.'));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateVolume', 'Failed To Update Bucket.'));
    } finally {
      setSaving(false);
    }
  };

  const fullName = `${owner}/${volume}`;

  const confirmVisibility = async () => {
    if (!detail) return;
    setSavingVisibility(true);
    try {
      const updated = await updateVolume(owner, volume, { isPrivate: !detail.isPrivate }, backend);
      patchDetail(() => updated);
      onUpdated(updated);
      showNotice('success', t('volumes.visibilityUpdated', 'Bucket Visibility Updated.'));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateVolume', 'Failed To Update Bucket.'));
    } finally {
      setSavingVisibility(false);
      setConfirmingVisibility(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteVolume(owner, volume, backend);
      showNotice('success', t('volumes.volumeDeleted', 'Bucket Deleted.'));
      onDeleted();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDeleteVolume', 'Failed To Delete Bucket.'));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('volumes.general', 'General')}</CardTitle>
          <RefreshButton onRefresh={reset} loading={saving || loading} />
        </CardHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="volume-settings-description">{t('volumes.description', 'Description')}</Label>
            <Textarea
              id="volume-settings-description"
              placeholder={t('volumes.descriptionPlaceholder', 'A Short Description Of This Bucket')}
              value={description}
              maxLength={500}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirty}>
              {t('common.saveChanges', 'Save Changes')}
            </Button>
          </div>
        </form>
      </Card>

      {detail && (
        <HrefPrefixModeCard
          owner={owner}
          volume={volume}
          detail={detail}
          showNotice={showNotice}
          onUpdated={onUpdated}
          backend={backend}
        />
      )}

      {/*
       Inside the same `detail` gate, and that is load-bearing rather than tidy.
       The replication card treats a 404 from `GET .../replications` as "this
       backend predates the feature" and says so instead of showing an error.
       That reading is only sound because `detail` proves the bucket exists and is
       owned — the backend answers 404 for a foreign volume too, so a caller who
       does not own this bucket never gets here. Outside the gate the two 404s
       would be indistinguishable and the skew notice would mask a real one.
       */}
      {detail && (
        <VolumeReplicationCard
          owner={owner}
          volume={volume}
          showNotice={showNotice}
          backend={backend}
        />
      )}

      <VolumeCredentialsCard owner={owner} volume={volume} showNotice={showNotice} backend={backend} />

      <Card className="border-[var(--color-error-text)]/40">
        <CardHeader>
          <CardTitle>{t('volumes.dangerZone', 'Danger Zone')}</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('volumes.changeVisibility', 'Change Visibility')}</p>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t(
                  'volumes.visibilityDescription',
                  'Changing Visibility Affects Who Can Read This Bucket. Making It Public Exposes Files To Anyone.',
                )}
              </p>
              {detail && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  {t('volumes.currentVisibility', 'Current Visibility: {{visibility}}', {
                    visibility: detail.isPrivate ? t('volumes.private', 'Private') : t('volumes.public', 'Public'),
                  })}
                </p>
              )}
            </div>
            <Button variant="danger" size="sm" loading={savingVisibility} onClick={() => setConfirmingVisibility(true)}>
              {detail?.isPrivate ? t('volumes.makePublic', 'Make Public') : t('volumes.makePrivate', 'Make Private')}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap border-t border-[var(--color-border)] pt-4">
            <div>
              <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('volumes.deleteThisBucket', 'Delete This Bucket')}</p>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t(
                  'volumes.deleteBucketDescription',
                  'Permanently Deletes The Bucket, Its Files, And Its Credentials. This Cannot Be Undone.',
                )}
              </p>
            </div>
            <Button variant="danger" size="sm" loading={deleting} onClick={() => setConfirmingDelete(true)}>
              {t('volumes.deleteBucket', 'Delete Bucket')}
            </Button>
          </div>
        </div>
      </Card>

      {confirmingVisibility && detail && (
        <TypeToConfirmModal
          title={detail.isPrivate ? t('volumes.makePublic', 'Make Public') : t('volumes.makePrivate', 'Make Private')}
          description={t(
            'volumes.visibilityDescription',
            'Changing Visibility Affects Who Can Read This Bucket. Making It Public Exposes Files To Anyone.',
          )}
          expectedName={fullName}
          confirmLabel={detail.isPrivate ? t('volumes.makePublic', 'Make Public') : t('volumes.makePrivate', 'Make Private')}
          loading={savingVisibility}
          onConfirm={() => void confirmVisibility()}
          onCancel={() => setConfirmingVisibility(false)}
        />
      )}

      {confirmingDelete && (
        <TypeToConfirmModal
          title={t('volumes.deleteBucket', 'Delete Bucket')}
          description={t(
            'volumes.deleteBucketDescription',
            'Permanently Deletes The Bucket, Its Files, And Its Credentials. This Cannot Be Undone.',
          )}
          expectedName={fullName}
          confirmLabel={t('volumes.deleteBucket', 'Delete Bucket')}
          loading={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
