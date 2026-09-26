import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { listBackends } from '../services/backendService';
import { apiPost } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Input, Label } from '../components/ui/Input';
import { ContextBar } from '../components/layout/ContextBar';
import { AppPage } from '../components/layout/AppPage';

export function NewVolumeView({
  defaultOwner,
  showNotice,
}: {
  defaultOwner: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [owner, setOwner] = useState(defaultOwner);
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [backend, setBackend] = useState('');
  const [backends, setBackends] = useState<Array<{ slug: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void listBackends()
      .then((rows) => {
        setBackends(rows);
        if (rows.length === 1 && rows[0]) setBackend(rows[0].slug);
      })
      .catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backend.trim()) {
      showNotice('error', t('volumes.selectBackend', 'Select A Backend First.'));
      return;
    }
    setSaving(true);
    try {
      const created = await apiPost<{ owner: string; name: string }>(
        `/user/volumes?backend=${encodeURIComponent(backend.trim())}`,
        { owner: owner.trim() || undefined, name: name.trim(), isPrivate },
      );
      showNotice('success', t('volumes.volumeCreated', 'Volume {{fullName}} Created.', { fullName: `${created.owner}/${created.name}` }));
      void navigate(`/${created.owner}/${created.name}?backend=${encodeURIComponent(backend.trim())}`);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateVolume', 'Failed To Create Volume.'));
    } finally {
      setSaving(false);
    }
  };

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
              <select value={backend} onChange={(e) => setBackend(e.target.value)} required className="w-full rounded border px-2 py-1.5 text-sm">
                <option value="">{t('volumes.chooseBackend', 'Choose A Backend')}</option>
                {backends.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.slug}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="mb-1.5">{t('volumes.owner', 'Owner')}</Label>
              <Input value={owner} onChange={(e) => setOwner(e.target.value)} required />
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
            <Button type="submit" variant="primary" loading={saving}>
              {t('volumes.createVolume', 'Create Volume')}
            </Button>
          </form>
        </Card>
      </AppPage>
    </div>
  );
}
