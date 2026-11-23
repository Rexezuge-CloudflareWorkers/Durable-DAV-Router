import { useTranslation } from 'react-i18next';
import { Header } from './components/layout/Header';
import { SpaViewRouter } from './components/layout/SpaViewRouter';
import { useNotice } from './hooks/useNotice';
import { useCurrentUser } from './hooks/useCurrentUser';
import { useSpaLanguage } from './hooks/useSpaLanguage';
import { NoticeBar } from '@rexezuge/web';

export default function SpaApp() {
  const { t } = useTranslation();
  const { notice, showNotice } = useNotice();
  const { user, setUser, authorized } = useCurrentUser();
  const { language, languageStatus, languagePending, handleLanguageChange } = useSpaLanguage({
    user,
    showNotice,
    setUser,
  });

  return (
    <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)]">
      <Header userEmail={user?.email ?? null} />
      {notice && <NoticeBar notice={notice} statusLabels={{ success: t('common.success', 'Success'), error: t('common.error', 'Error') }} />}

      <SpaViewRouter
        user={user}
        setUser={setUser}
        authorized={authorized}
        showNotice={showNotice}
        language={languageStatus === 'error' ? 'unknown' : language}
        onLanguageChange={handleLanguageChange}
        languageDisabled={languagePending || languageStatus !== 'ready'}
      />
    </div>
  );
}
