import { cn } from '@rexezuge/web';

/**
 * One field treatment for every control.
 *
 * The ring is deliberately on `focus-visible` in addition to the border colour:
 * a keyboard user needs the focus to be obvious against a surface that is only
 * a few steps lighter than the field itself.
 */
const fieldClass =
  'w-full rounded-lg bg-[var(--color-surface-base)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] transition-colors duration-150 focus:outline-none focus:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/30 disabled:opacity-60 disabled:cursor-not-allowed';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, className)} {...props} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldClass, 'appearance-none pr-8', className)} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]', className)} {...props}>
      {children}
    </label>
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldClass, 'min-h-20 resize-y', className)} {...props} />;
}

/**
 * A labelled native checkbox.
 *
 * Native rather than a rebuilt switch: the platform control keeps its keyboard
 * behaviour, its form semantics and its screen-reader announcement, and the
 * accent colour is enough to make it belong here.
 */
export function Checkbox({
  label,
  className,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className={cn('flex items-start gap-2.5 text-sm text-[var(--color-text-secondary)] cursor-pointer', className)}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--color-border)] bg-[var(--color-surface-base)] accent-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40"
        {...props}
      />
      <span className="min-w-0">
        <span className="block text-[var(--color-text-primary)]">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">{hint}</span>}
      </span>
    </label>
  );
}

export function FieldHint({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn('text-xs text-[var(--color-text-muted)]', className)}>{children}</p>;
}
