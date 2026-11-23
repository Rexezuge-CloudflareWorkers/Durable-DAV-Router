import { useTranslation } from 'react-i18next';
import { Settings, UserRound } from 'lucide-react';
import type { CurrentUser } from '../types';
import { LanguageSettingsCard } from '../components/settings/LanguageSettingsCard';
import { ProfileSettingsCard } from '../components/settings/ProfileSettingsCard';
import { BackendsSettingsCard } from '../components/settings/BackendsSettingsCard';
import { BreadcrumbBar } from '../components/layout/BreadcrumbBar';
import { AppPage, PageHeaderCard } from '@rexezuge/web';
import { cn } from '@rexezuge/web';

/**
 * Settings, with a section rail instead of one undifferentiated stack.
 *
 * The cards are still all rendered — each one owns its own load and there is no
 * reason to defer two requests behind a tab — but the rail gives the page a
 * shape and a way to jump to the section you came for.
 */
const SECTION_LINKS = [
  { id: 'profile', key: 'settings.profile', fallback: 'Profile', icon: UserRound },
  { id: 'backends', key: 'backends.title', fallback: 'Backends', icon: Settings },
  { id: 'preferences', key: 'settings.preferences', fallback: 'Preferences', icon: Settings },
] as const;

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
      <BreadcrumbBar crumb={<span className="truncate">{t('settings.userSettings', 'User Settings')}</span>} />
      <AppPage>
        <PageHeaderCard
          icon={<UserRound className="h-5 w-5 text-[var(--color-accent)]" />}
          title={t('settings.userSettings', 'User Settings')}
          description={user.email}
        />

        <div className="grid items-start gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
          <nav
            aria-label={t('settings.userSettings', 'User Settings')}
            className="lg:sticky lg:top-28 flex gap-1 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-1.5 lg:flex-col"
          >
            {SECTION_LINKS.map(({ id, key, fallback, icon: Icon }) => (
              <a
                key={id}
                href={`#${id}`}
                className={cn(
                  'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors duration-150',
                  'hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50',
                )}
              >
                <Icon className="h-4 w-4 text-[var(--color-text-muted)]" />
                {t(key, fallback)}
              </a>
            ))}
          </nav>

          <div className="min-w-0 space-y-4">
            <div id="profile" className="scroll-mt-32">
              <ProfileSettingsCard user={user} setUser={setUser} showNotice={showNotice} />
            </div>
            <div id="backends" className="scroll-mt-32">
              <BackendsSettingsCard showNotice={showNotice} />
            </div>
            <div id="preferences" className="scroll-mt-32">
              <LanguageSettingsCard language={language} onLanguageChange={onLanguageChange} disabled={languageDisabled} />
            </div>
          </div>
        </div>
      </AppPage>
    </div>
  );
}
