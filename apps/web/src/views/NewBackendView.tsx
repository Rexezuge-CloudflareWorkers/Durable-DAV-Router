import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { createBackend } from '../services/backendService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Input, Label } from '../components/ui/Input';
import { ContextBar } from '../components/layout/ContextBar';
import { AppPage } from '../components/layout/AppPage';

export function NewBackendView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [slug, setSlug] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await createBackend({
        slug: slug.trim().toLowerCase(),
        baseUrl: baseUrl.trim(),
        displayName: displayName.trim() === '' ? null : displayName.trim(),
      });
      showNotice('success', t('backends.created', 'Backend {{slug}} Registered.', { slug: created.slug }));
      void navigate('/');
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateBackend', 'Failed To Register Backend.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <ContextBar
        crumb={
          <span className="text-xl font-semibold text-[var(--color-text-primary)] truncate">{t('backends.newBackend', 'New Backend')}</span>
        }
      />
      <AppPage variant="narrow">
        <Card>
          <CardHeader>
            <CardTitle>{t('backends.newBackend', 'New Backend')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label className="mb-1.5">{t('backends.slug', 'Slug')}</Label>
              <Input placeholder="office" value={slug} onChange={(e) => setSlug(e.target.value)} required />
            </div>
            <div>
              <Label className="mb-1.5">{t('backends.baseUrl', 'Base URL')}</Label>
              <Input placeholder="https://dav.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
            </div>
            <div>
              <Label className="mb-1.5">{t('backends.displayName', 'Display Name (Optional)')}</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <Button type="submit" variant="primary" loading={saving}>
              {t('backends.register', 'Register Backend')}
            </Button>
          </form>
        </Card>
      </AppPage>
    </div>
  );
}
