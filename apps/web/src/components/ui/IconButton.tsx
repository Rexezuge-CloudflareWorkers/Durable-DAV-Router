import { cn } from '@rexezuge/web';

/**
 * An icon-only button.
 *
 * `label` is required rather than optional: an icon alone has no accessible
 * name, so every call site has to say what the control does. The visible
 * tooltip is the same string, which keeps the two from drifting.
 */
export function IconButton({
  label,
  className,
  children,
  tone = 'neutral',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: React.ReactNode;
  tone?: 'neutral' | 'danger' | 'accent';
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50',
        'disabled:opacity-40 disabled:pointer-events-none',
        tone === 'neutral' && 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]',
        tone === 'danger' && 'text-[var(--color-text-muted)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error-text)]',
        tone === 'accent' && 'text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
