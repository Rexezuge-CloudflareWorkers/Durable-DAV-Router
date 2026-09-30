/**
 * Trailing-separator trimming (Layer 0).
 *
 * Five loops in this repository did this — in `BackendProxyService`,
 * `AccessAuthService`, `AppConfiguration`, and `SsrfHosts` (which trims a dot
 * rather than a slash) — and one of them had already drifted to a
 * `codePointAt`/`charAt` variant of the same loop. A trailing slash is load-bearing
 * in three places at once: a `baseUrl` join must not produce `https://host//path`,
 * a `TEAM_DOMAIN` must not become a JWKS URL with a doubled separator, and a
 * cache key must not differ because of one.
 *
 * One implementation, in Layer 0, so no layer has to import a neighbour's module
 * for a string utility.
 */

/**
 * Strip every trailing `/`.
 *
 * Uses a scan rather than a regex or a `split('/')` join because the input is a
 * URL path or origin: a regex with a global flag is stateful across calls, and
 * splitting a path on `/` and rejoining it destroys empty segments, which are
 * meaningful in a path (`/a//b` is not `/a/b`).
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(0, end);
}

export { stripTrailingSlashes };
