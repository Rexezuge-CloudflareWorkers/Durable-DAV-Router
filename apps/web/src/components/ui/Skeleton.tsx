import { cn } from '@rexezuge/web';

/**
 * A loading placeholder.
 *
 * It is decorative: a spinner or a status line still carries the accessible
 * "loading" announcement, so the skeleton itself is hidden from assistive tech
 * rather than read out as a set of empty boxes.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-[var(--color-surface-3)]', className)} />;
}

export function SkeletonRows({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
