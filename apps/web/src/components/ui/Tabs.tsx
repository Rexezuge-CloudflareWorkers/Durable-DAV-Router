import { cn } from '@rexezuge/web';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

/**
 * A real tablist.
 *
 * The previous Files/Buckets switcher was two `Button`s: it looked like a
 * segmented control but announced nothing about the relationship between the
 * buttons and the panel below them. `role="tab"`/`aria-selected` gives assistive
 * tech the same model the URL already carries in `?tab=`.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('inline-flex items-center gap-1 rounded-lg bg-[var(--color-surface-2)] p-1', className)}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50',
              active
                ? 'bg-[var(--color-surface-4)] text-[var(--color-text-primary)] shadow-sm'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
