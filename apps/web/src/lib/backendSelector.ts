/**
 * The `?backend=` upstream selector.
 *
 * One implementation, because there were five. `volumeService` passed a params
 * map, `credentialService` appended to a string with an `&`/`?` check,
 * `davClient` inlined the base path and the selector in a template literal, and
 * `backendService` had neither — five shapes across four files, each correct, and
 * a dropped selector in any one of them silently targets the wrong backend or
 * none.
 *
 * `apps/web/AGENTS.md` names this as a known duplication; it is now resolved, and
 * `test/web-services.test.ts` pins the two properties that matter: the selector
 * appears exactly once, and an absent selector produces no `?backend=` at all.
 */

/**
Encoded `?backend=<slug>`, or `''` when there is no selector.
*/
function backendSelector(backend?: string | null): string {
  return backend ? `backend=${encodeURIComponent(backend)}` : '';
}

/**
 * Append the selector to a URL that may already carry a query string.
 *
 * The separator is derived rather than assumed: `davClient.entryUrl` already
 * appends `?backend=` before `listDirectory` adds `?page=`/`?limit=`, and a second
 * `?` silently drops the paging parameters — the symptom is a pager stuck on
 * page 1 with no error anywhere.
 */
function withBackendSelector(url: string, backend?: string | null): string {
  return appendQuery(url, backendSelector(backend));
}

/**
 * Add the selector to an `apiGet` parameter map.
 *
 * The map form rather than a string, because `apiGet` builds the query with
 * `URLSearchParams` and these values are plain slugs with no encoding questions.
 */
function withBackendParam<T extends Record<string, string | undefined>>(
  params: T,
  backend?: string | null,
): Record<string, string | undefined> {
  return backend ? { ...params, backend } : params;
}

/**
 * Append an already-encoded query string, choosing the separator.
 *
 * `?` when the URL has no query, `&` when it does. The separator is the whole
 * reason this exists: `davClient.listDirectory` adds paging to a URL that
 * `entryUrl` may already have given a `?backend=`, and a second `?` silently
 * drops the paging parameters — the symptom being a pager permanently stuck on
 * page 1 with no error anywhere.
 */
function appendQuery(url: string, query: string): string {
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

export { backendSelector, withBackendSelector, withBackendParam, appendQuery };
