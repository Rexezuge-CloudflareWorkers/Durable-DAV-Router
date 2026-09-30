import { useCallback, useRef, useState } from 'react';

/**
 * One shape for "run an async action, tell the user how it went".
 *
 * The bucket browser's five mutations were five copies of `setBusy(true)` /
 * `try` / `showNotice` / `showNotice(error)` / `finally setBusy(false)`. Two
 * consequences, both invisible until they happened: a mutation that returned
 * early could leave `busy` stuck true and wedge the whole toolbar, and a fifth
 * variant could forget the `finally` entirely — which disables every button in
 * the bucket browser until the next reload.
 *
 * `run` keeps the invariant in one place: `busy` is cleared on every path,
 * including a thrown one and an early return, and a stale run cannot clear the
 * flag out from under a newer one.
 */
function useBusyAction(): {
  busy: boolean;
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
} {
  const [busy, setBusy] = useState(false);
  // Monotonic so two overlapping actions cannot interleave their cleanup: only
  // the newest run clears `busy`.
  const generation = useRef(0);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    const mine = ++generation.current;
    setBusy(true);
    try {
      return await action();
    } finally {
      if (generation.current === mine) setBusy(false);
    }
  }, []);

  return { busy, run };
}

export { useBusyAction };
