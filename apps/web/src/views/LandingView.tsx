import { FolderArchive, Lock, Sparkles, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ZERO_TRUST_AUTHENTICATION_PATH } from '../lib/constants';
import { AppPage } from '@rexezuge/web';

function signIn() {
  globalThis.location.assign(ZERO_TRUST_AUTHENTICATION_PATH);
}

export function LandingView() {
  const { t } = useTranslation();
  return (
    <AppPage variant="hero">
      <div className="mx-auto max-w-2xl animate-fade-in-up text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-secondary)]">
          <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />
          {t('landing.eyebrow', 'Durable Objects · WebDAV · Cloudflare Access')}
        </span>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-[var(--color-text-primary)] sm:text-5xl">
          {t('landing.title', 'Self-Hosted WebDAV On Cloudflare Workers')}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[var(--color-text-secondary)]">
          {t(
            'landing.subtitle',
            'Buckets Backed By Durable Objects, Served Over WebDAV. Each Bucket Has Its Own Credentials; Private Buckets Stay Protected.',
          )}
        </p>
        <div className="mt-8">
          <Button variant="primary" size="lg" onClick={signIn}>
            {t('landing.signIn', 'Sign In With Cloudflare Access')}
          </Button>
        </div>
      </div>

      <div className="mt-14 grid animate-stagger-1 gap-4 md:grid-cols-3">
        <Feature
          icon={<FolderArchive className="h-4 w-4" />}
          title={t('landing.webdav', 'WebDAV Class 1+2')}
          description={t('landing.webdavDescription', 'Mount, Sync, And Edit With Any WebDAV Client.')}
        />
        <Feature
          icon={<Zap className="h-4 w-4" />}
          title={t('landing.edgeStorage', 'Edge Storage')}
          description={t('landing.edgeStorageDescription', 'One Durable Object Per Bucket, SQLite-Backed.')}
        />
        <Feature
          icon={<Lock className="h-4 w-4" />}
          title={t('landing.accessControl', 'Access Control')}
          description={t('landing.accessControlDescription', 'Per-Bucket Credentials For WebDAV; Cloudflare Access For The Web UI.')}
        />
      </div>
    </AppPage>
  );
}

function Feature({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <Card className="text-left">
      <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-surface-3)] text-[var(--color-accent)]">{icon}</span>
      <h2 className="mb-1 text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
      <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">{description}</p>
    </Card>
  );
}
