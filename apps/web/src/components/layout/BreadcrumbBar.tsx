import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ContextBar } from '@rexezuge/web';

/**
 * The contextual strip beneath the global shell header.
 *
 * The header is the app's only navigation bar, so this strip adds no second
 * logo: its home slot is a compact text link, and only the kit bar's pinned,
 * full-width chrome is overridden so the strip stays in the page flow. The
 * kit still supplies the breadcrumb layout, the separator and the action
 * slot, keeping those in one place instead of repeating them in every view.
 */
export function BreadcrumbBar({ crumb, actions }: { crumb: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ContextBar
      className="static border-b-0 bg-transparent backdrop-blur-none"
      home={
        <Link
          to="/"
          aria-label={t('header.home', 'Durable-DAV-Router Home')}
          className="rounded font-medium text-[var(--color-text-muted)] hover:text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
        >
          {t('header.dashboard', 'Dashboard')}
        </Link>
      }
      crumb={<span className="truncate text-base font-semibold text-[var(--color-text-primary)]">{crumb}</span>}
      actions={actions}
    />
  );
}
