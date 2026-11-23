import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ContextBar } from '@rexezuge/web';
import { Logo } from './Logo';

/**
 * The contextual bar under the shell header.
 *
 * It sits at `top-14` because the header is `h-14` and sticky: two sticky bars
 * both pinned at `top-0` stack on top of each other, and the one that wins is
 * whichever renders later. Wrapping the kit's bar keeps the home link, the
 * crumb typography and the action slot in one place instead of repeating the
 * same five lines in every contextual view.
 */
export function BreadcrumbBar({ crumb, actions }: { crumb: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ContextBar
      className="top-14 z-30"
      home={
        <Link
          to="/"
          aria-label={t('header.home', 'Durable-DAV-Router Home')}
          className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
        >
          <Logo />
        </Link>
      }
      crumb={<span className="truncate text-base font-semibold text-[var(--color-text-primary)]">{crumb}</span>}
      actions={actions}
    />
  );
}
