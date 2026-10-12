/**
 * Memoize an async factory for the life of one request scope.
 *
 * The kit's DI ships the container and the scope, but not the promise memo:
 * a factory here must be called at most once per scope even when several
 * services resolve the same DAO, and a *failed* call must not be cached —
 * otherwise one transient D1 error would poison the token for the rest of
 * the request, which is the opposite of retrying.
 *
 * Local rather than in the kit because the kit's scope resolves tokens the
 * container owns; this one memoizes a factory the composition root hands it.
 */
function memoizeAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = fn();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

export { memoizeAsync };
