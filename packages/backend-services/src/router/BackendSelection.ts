import { ConflictError, NotFoundError } from '@durable-dav-router/backend-errors';
import { resolveBackend } from './BackendProxyService';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';

/**
 * Resolve which backend a management request targets.
 *
 * `?backend=` (or `X-Backend`) disambiguates when the caller has several
 * registered backends; a lone backend is used implicitly. Anything else is an
 * error the caller has to resolve.
 *
 * Throws the typed errors `BaseRoute.toErrorResponse` maps rather than
 * returning a Response, so the caller keeps proxying on the happy path and the
 * 404/409 envelope is built in exactly one place. That literal was previously
 * repeated at five call sites and had already drifted from the canonical
 * `Exception.Type` strings.
 */
function selectBackend(backends: RouterBackendRow[], explicitSlug: string | null, what = 'backend'): RouterBackendRow {
  const resolved = resolveBackend(backends, explicitSlug);
  if (resolved.kind === 'not-found') {
    // Distinct from "ambiguous": the caller named a backend that is not theirs,
    // or has none. The message is intentionally vague so it cannot be used to
    // enumerate another tenant's slugs.
    throw new NotFoundError(`No ${what} matches this request`);
  }
  if (resolved.kind === 'ambiguous') {
    throw new ConflictError('Multiple backends match; retry with ?backend=<slug>', { backends: resolved.backends.map((b) => b.slug) });
  }
  return resolved.backend;
}

/**
 * Read the backend selector: query string first, then the `X-Backend` header.
 *
 * The header exists for clients that cannot set a query string on a WebDAV
 * method. `resolveBackend` trims, so a whitespace-only value is treated as
 * absent rather than as an unknown slug.
 */
function explicitBackendSlug(c: {
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined };
}): string | null {
  const q = c.req.query('backend');
  if (q?.trim()) return q.trim();
  const h = c.req.header('X-Backend');
  return h?.trim() ? h.trim() : null;
}

export { selectBackend, explicitBackendSlug };
