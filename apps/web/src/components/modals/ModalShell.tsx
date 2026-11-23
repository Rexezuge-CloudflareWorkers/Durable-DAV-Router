import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalShell as KitModalShell } from '@rexezuge/web';

/**
 * The app's modal.
 *
 * `@rexezuge/web`'s `ModalShell` closes on Escape but does not move focus into
 * the dialog, keep Tab inside it, or give focus back on close — so a keyboard
 * user opened a dialog and kept tabbing through the page behind it. This wraps
 * that primitive rather than replacing it, so the portal, backdrop, entrance
 * animation and close control stay shared (and the build gate that proves the
 * kit is being styled keeps meaning something).
 */
export function ModalShell({ children, closeLabel, ...props }: React.ComponentProps<typeof KitModalShell>) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = containerRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      dialog
        ? [
            ...dialog.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ]
        : [];

    const preferred = dialog?.querySelector<HTMLElement>('[autofocus], input:not([disabled]), textarea:not([disabled])');
    (preferred ?? focusables()[0])?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items.pop();
      const active = document.activeElement as HTMLElement | null;
      const outside = !dialog || !dialog.contains(active);
      if (event.shiftKey) {
        if (active === first || outside) {
          event.preventDefault();
          last?.focus();
        }
        return;
      }
      if (!last || active !== last) {
        return;
      }

      event.preventDefault();
      first?.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <KitModalShell {...props} closeLabel={closeLabel ?? t('common.close', 'Close')}>
      <div ref={containerRef}>{children}</div>
    </KitModalShell>
  );
}

export function ModalHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4 pr-12">
      <h2 className="truncate text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ModalBody({ children }: { children: ReactNode }) {
  return <div className="max-h-[calc(82vh-4rem)] space-y-2.5 overflow-y-auto p-5">{children}</div>;
}
