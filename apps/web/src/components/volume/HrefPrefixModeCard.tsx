import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DavHrefPrefixMode, VolumeDetail } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { updateVolume } from '../../services/volumeService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Label, Select } from '../ui/Input';

/**
 * Per-bucket `DAV:href` anchoring, owned by the backend.
 *
 * The default (`base`) is what RFC 4918 §8.3 requires: every `DAV:href` is a
 * URI reference that resolves against the request URL, so it carries the
 * `/owner/volume` base. `root` is the escape hatch for clients that instead
 * expect the volume root at `/` — they will not be argued out of it, and they
 * 404 on every entry without it.
 *
 * The router adds nothing to this: 207 bodies are forwarded verbatim and the
 * mode rides through on the proxied `/user/volumes` JSON. That is why the
 * description says the change applies to the *bucket on the backend* — it also
 * changes what a client connecting straight to that backend sees, which is not
 * obvious from a control living in the router's settings tab.
 *
 * Not in the Danger Zone despite affecting client compatibility: it is
 * reversible, touches no data, and burying it next to "Delete Bucket" invites
 * the wrong click.
 */
export function HrefPrefixModeCard({
  owner,
  volume,
  detail,
  showNotice,
  onUpdated,
  backend,
}: {
  owner: string;
  volume: string;
  detail: VolumeDetail;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onUpdated: (detail: VolumeDetail) => void;
  backend?: string | null;
}) {
  const { t } = useTranslation();
  const current = detail.hrefPrefixMode;
  const [selected, setSelected] = useState<DavHrefPrefixMode>(current);
  const [saving, setSaving] = useState(false);
  const dirty = selected !== current;

  const submit = async () => {
    setSaving(true);
    try {
      const updated = await updateVolume(owner, volume, { hrefPrefixMode: selected }, backend);
      onUpdated(updated);
      showNotice('success', t('volumes.hrefPrefixModeUpdated', 'Bucket Link Prefix Updated.'));
    } catch (error) {
      // Snap back to the server's value: the PATCH failed, so the mode on screen
      // was never applied and leaving the optimistic selection would misreport a
      // compatibility change the backend never accepted.
      setSelected(current);
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateVolume', 'Failed To Update Bucket.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('volumes.linkPrefix', 'Link Prefix')}</CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t(
            'volumes.hrefPrefixModeDescription',
            'Controls The Path WebDAV Clients See In File Links. The Default Includes The Bucket Name, Which Is What Most Clients Expect. Some Clients Require Paths Starting At The Root Instead. This Is Stored On The Backend, So It Also Applies To Clients Connected Directly To It.',
          )}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="volume-href-prefix-mode">{t('volumes.hrefPrefixMode', 'Link Prefix')}</Label>
          <Select
            id="volume-href-prefix-mode"
            value={selected}
            disabled={saving}
            onChange={(e) => setSelected(e.target.value as DavHrefPrefixMode)}
          >
            <option value="base">{t('volumes.hrefPrefixModeBase', 'Include Bucket Name (Recommended)')}</option>
            <option value="root">{t('volumes.hrefPrefixModeRoot', 'Start At Root')}</option>
          </Select>
          <p className="text-xs text-[var(--color-text-muted)]">
            {selected === 'base'
              ? t('volumes.hrefPrefixModeBaseExample', 'Example: /{{owner}}/{{name}}/photos/image.jpg', { owner, name: volume })
              : t('volumes.hrefPrefixModeRootExample', 'Example: /photos/image.jpg')}
          </p>
        </div>
        <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={() => void submit()}>
          {t('common.saveChanges', 'Save Changes')}
        </Button>
      </div>
    </Card>
  );
}
