import { cn } from '@rexezuge/web';

/**
 * The surface every page is built from.
 *
 * `interactive` is for a card that wraps a link or a click handler: it gets a
 * pointer cursor, a lifted border and a faint accent tint on hover. `danger`
 * marks a destructive section without colouring its contents.
 */
export function Card({
  className,
  children,
  variant = 'default',
}: {
  className?: string;
  children: React.ReactNode;
  variant?: 'default' | 'interactive' | 'danger' | 'muted';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-[var(--color-surface-1)] p-5 transition-colors duration-150',
        variant === 'default' && 'border-[var(--color-border)]',
        variant === 'interactive' &&
          'border-[var(--color-border)] hover:border-[var(--color-surface-4)] hover:bg-[var(--color-surface-2)]',
        variant === 'danger' && 'border-[var(--color-error-text)]/40',
        variant === 'muted' && 'border-[var(--color-border)] bg-[var(--color-surface-2)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex items-center justify-between gap-3 mb-4', className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h2 className={cn('text-base font-semibold text-[var(--color-text-primary)]', className)}>{children}</h2>;
}

export function CardDescription({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn('text-sm text-[var(--color-text-secondary)]', className)}>{children}</p>;
}
