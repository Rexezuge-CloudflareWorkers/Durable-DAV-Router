import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Logo } from '../components/layout/Logo';
import { UserRound } from 'lucide-react';
import type { CurrentUser } from '../types';
import { LanguageSettingsCard } from '../components/settings/LanguageSettingsCard';
import { ProfileSettingsCard } from '../components/settings/ProfileSettingsCard';
import { BackendsSettingsCard } from '../components/settings/BackendsSettingsCard';
import { ContextBar, AppPage, PageHeaderCard } from '@rexezuge/web';

export function SettingsView({
  user,
  setUser,
  showNotice,
  language,
  onLanguageChange,
  languageDisabled,
}: {
  user: CurrentUser;
  setUser: (user: CurrentUser) => void;
  showNotice: (kind: 'success' | 'error', message: string) => void;
  language: string;
  onLanguageChange: (lng: string) => void;
  languageDisabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <ContextBar
        home={
          <Link to="/" aria-label={t('header.home', 'Durable-DAV-Router Home')}>
            <Logo />
          </Link>
        }
        crumb={
          <span className="text-xl font-semibold text-[var(--color-text-primary)] truncate">
            {t('settings.userSettings', 'User Settings')}
          </span>
        }
      />
      <AppPage>
        <PageHeaderCard
          icon={<UserRound className="h-5 w-5 text-[var(--color-text-secondary)]" />}
          title={t('settings.userSettings', 'User Settings')}
          description={user.email}
        />

        <ProfileSettingsCard user={user} setUser={setUser} showNotice={showNotice} />

        <BackendsSettingsCard showNotice={showNotice} />

        <LanguageSettingsCard language={language} onLanguageChange={onLanguageChange} disabled={languageDisabled} />
      </AppPage>
    </div>
  );
}
