import { useCallback, useEffect, useEffectEvent, useState } from 'react';

/**
 * Joins the two halves of a request key.
 *
 * NUL because a caller's own key is arbitrary text and could contain anything a
 * visible separator might — so `('a', 1)` and `('a1', '')` must not collide into
 * one key, or a reload of one bucket would read as a settled load of another.
 */
const KEY_SEPARATOR = String.fromCodePoint(0);

/**
 * Load on mount, and again on demand, with the cancellation every consumer
 * otherwise hand-rolled.
 *
 * Six call sites needed the same three things — a value, a loading flag, and a
 * way to re-run — and the part that is easy to get wrong is the cancellation: an
 * in-flight request that settles after a newer one, or after unmount, must not
 * write state. Six independent copies of that guard is six chances for one to be
 * missing, and one was: `DashboardView` had the pattern's body without the flag,
 * so a superseded load won on StrictMode's double-invoked mount effect and on any
 * refresh overlapping a slow request.
 *
 * `load` and `onError` go through `useEffectEvent`, so a loader that closes over
 * props — `showNotice`, `t`, the current `owner` — keeps a stable identity and
 * does *not* become a dependency. The naive version re-fires the request on every
 * render, because those closures are fresh each time. Only `reloadKey` (an
 * explicit key the caller composes) and `reload()` re-run it.
 *
 * `loading` is derived from which request last settled, never stored as a flag:
 * setting a flag to true at the top of an effect is a synchronous state update,
 * which re-renders the component that just asked for the reload before it has
 * done anything. Here the newest request and the newest settled request are
 * compared, so the flag cannot disagree with the request it describes.
 */
function useAsyncLoad<T>(
  load: () => Promise<T>,
  options?: { reloadKey?: string | number; onError?: (error: unknown) => void },
): {
  data: T | undefined;
  loading: boolean;
  reload: () => void;
  /**
   * Patch the loaded value in place, without reloading.
   *
   * For optimistic UI: a row whose flag has been flipped or whose name has been
   * typed should not wait a network round trip to render, and the caller reverts
   * the patch on failure. Exposed here rather than by keeping a parallel copy of
   * the list in the consumer, because two sources of truth for one list is how
   * "the badge shows the new value but the server still has the old one" becomes
   * unrecoverable.
   *
   * No-op while there is nothing loaded: there is no value to patch yet.
   */
  patch: (update: (current: T) => T) => void;
} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  // The caller's key identifies *what* is being loaded; `reloadCount` identifies
  // *which attempt*. Both matter: two different buckets and two refreshes of one
  // bucket are different requests, and the second must not read as already done.
  const requestKey = `${options?.reloadKey ?? ''}${KEY_SEPARATOR}${reloadCount}`;

  // Marked as effect events: called from inside the effect, never during render,
  // and deliberately not dependencies.
  const loadNow = useEffectEvent(load);
  const reportError = useEffectEvent((error: unknown) => options?.onError?.(error));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await loadNow();
        if (cancelled) return;
        setData(result);
      } catch (error) {
        if (cancelled) return;
        reportError(error);
      } finally {
        // Only the newest request may clear the flag, so an older one settling
        // late cannot report a pending request as done.
        if (!cancelled) setSettledKey(requestKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  const reload = useCallback(() => {
    setReloadCount((count) => count + 1);
  }, []);

  const patch = useCallback((update: (current: T) => T) => {
    setData((current) => (current === undefined ? current : update(current)));
  }, []);

  return { data, loading: settledKey !== requestKey, reload, patch };
}

export { useAsyncLoad };
