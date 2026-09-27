import { GitFork } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function Logo() {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-2 text-xl font-semibold tracking-tight whitespace-nowrap">
      <GitFork className="h-5 w-5 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
      <span>
        <span className="text-[var(--color-accent)]">{t('header.brandAccent', 'Durable-DAV-')}</span>
        <span className="text-[var(--color-text-primary)]">{t('header.brandRest', 'Router')}</span>
      </span>
    </span>
  );
}
