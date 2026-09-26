import { useMatch } from 'react-router-dom';
import { Header } from './components/layout/Header';
import { NoticeBar } from './components/layout/NoticeBar';
import { SpaViewRouter } from './components/layout/SpaViewRouter';
import { useNotice } from './hooks/useNotice';
import { useCurrentUser } from './hooks/useCurrentUser';
import { useSpaLanguage } from './hooks/useSpaLanguage';

function TopHeader({ userEmail }: { userEmail: string | null }) {
  // The marketing/global header is root-only: every other route renders a
  // contextual `ContextBar` instead, so the top anchor never moves pages.
  const isRootPage = useMatch('/') !== null;
  return isRootPage ? <Header userEmail={userEmail} /> : null;
}

export default function SpaApp() {
  const { notice, showNotice } = useNotice();
  const { user, setUser, authorized } = useCurrentUser();
  const { language, languageStatus, languagePending, handleLanguageChange } = useSpaLanguage({
    user,
    showNotice,
    setUser,
  });

  return (
    <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)]">
      <TopHeader userEmail={user?.email ?? null} />
      {notice && <NoticeBar notice={notice} />}

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
