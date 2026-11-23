import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, Menu, Plus, Settings, UserRound, X } from 'lucide-react';
import { cn } from '@rexezuge/web';
import { Logo } from './Logo';
import { ZERO_TRUST_AUTHENTICATION_PATH } from '../../lib/constants';

/**
 * The shell header, on every route.
 *
 * It used to render only on `/`, so a bucket page had no way back to the
 * dashboard or into settings without editing the URL. The nav items are real
 * `NavLink`s rather than buttons calling `navigate()`: a link is what the
 * browser gives a context menu, a middle click and a keyboard `Enter`, and
 * `aria-current` is what tells assistive tech which section is open.
 */
function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50',
    isActive
      ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
      : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-secondary)]',
  );
}

function items(t: (key: string, fallback: string) => string) {
  return [
    { to: '/', label: t('header.dashboard', 'Dashboard'), icon: <LayoutGrid className="h-4 w-4" />, end: true },
    { to: '/new', label: t('header.new', 'New'), icon: <Plus className="h-4 w-4" />, end: false },
    { to: '/settings', label: t('header.settings', 'Settings'), icon: <Settings className="h-4 w-4" />, end: false },
  ];
}

export function Header({ userEmail }: { userEmail: string | null }) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const links = items(t);
  const closeMenu = () => setMenuOpen(false);

  const initial = userEmail?.trim().charAt(0).toUpperCase() ?? null;

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface-base)]/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link to="/" className="flex shrink-0 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50">
            <Logo />
          </Link>

          {userEmail && (
            <nav className="hidden items-center gap-0.5 md:flex" aria-label={t('header.primaryNav', 'Primary')}>
              {links.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </nav>
          )}
        </div>

        <div className="flex items-center gap-2">
          {userEmail ? (
            <>
              <span className="hidden min-w-0 items-center gap-2 rounded-lg bg-[var(--color-surface-2)] py-1 pl-1 pr-3 sm:flex">
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-4)] text-xs font-semibold text-[var(--color-text-secondary)]"
                >
                  {initial ?? <UserRound className="h-3.5 w-3.5" />}
                </span>
                <span className="max-w-48 truncate text-xs text-[var(--color-text-secondary)]">{userEmail}</span>
              </span>
              <button
                type="button"
                aria-expanded={menuOpen}
                aria-controls="shell-mobile-nav"
                aria-label={menuOpen ? t('header.closeMenu', 'Close Menu') : t('header.openMenu', 'Open Menu')}
                onClick={() => setMenuOpen((open) => !open)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50 md:hidden"
              >
                {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>
            </>
          ) : (
            <a
              href={ZERO_TRUST_AUTHENTICATION_PATH}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
            >
              {t('landing.signIn', 'Sign In With Cloudflare Access')}
            </a>
          )}
        </div>
      </div>

      {userEmail && menuOpen && (
        <nav
          id="shell-mobile-nav"
          aria-label={t('header.primaryNav', 'Primary')}
          className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 md:hidden"
        >
          <div className="flex flex-col gap-1">
            {links.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass} onClick={closeMenu}>
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </div>
          <p className="mt-3 truncate border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">{userEmail}</p>
        </nav>
      )}
    </header>
  );
}
