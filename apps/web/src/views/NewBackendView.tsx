import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { createBackend } from '../services/backendService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { FieldHint, Input, Label } from '../components/ui/Input';
import { BreadcrumbBar } from '../components/layout/BreadcrumbBar';
import { AppPage, PageHeaderCard } from '@rexezuge/web';

export function NewBackendView({ showNotice }: { showNotice: (kind: 'success' | 'error', message: string) => void }) {
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
      <BreadcrumbBar crumb={<span className="truncate">{t('backends.newBackend', 'New Backend')}</span>} />
      <AppPage variant="narrow">
        <PageHeaderCard
          icon={<Server className="h-5 w-5 text-[var(--color-accent)]" />}
          title={t('backends.newBackend', 'New Backend')}
          description={t('backends.subtitle', 'A Backend Is Another Durable-DAV Instance This Router Forwards To.')}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('backends.connection', 'Connection')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-backend-slug">{t('backends.slug', 'Slug')}</Label>
              <Input
                id="new-backend-slug"
                placeholder="office"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                className="font-mono"
              />
              <FieldHint>{t('backends.slugHint', 'A Short Identifier Used In Links And The ?backend= Selector.')}</FieldHint>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-backend-url">{t('backends.baseUrl', 'Base URL')}</Label>
              <Input
                id="new-backend-url"
                type="url"
                placeholder="https://dav.example.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              <FieldHint>{t('backends.baseUrlHint', 'The Origin Only. The Router Appends The Bucket Path Itself.')}</FieldHint>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-backend-name">{t('backends.displayName', 'Display Name (Optional)')}</Label>
              <Input
                id="new-backend-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="off"
              />
              <FieldHint>{t('backends.displayNameHint', 'Shown Instead Of The Slug In Settings And Bucket Cards.')}</FieldHint>
            </div>
            <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
              <Button type="submit" variant="primary" loading={saving}>
                {t('backends.register', 'Register Backend')}
              </Button>
            </div>
          </form>
        </Card>
      </AppPage>
    </div>
  );
}
