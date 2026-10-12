import { ConflictError, NotFoundError } from '@rexezuge/errors';
import { resolveBackend } from './BackendProxyService';
import type { RoutableBackend } from './BackendProxyService';

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
/**
 * An ambiguous `?backend=` selector, carrying the candidates that matched.
 *
 * A plain `ConflictError` (the kit's) says "retry with ?backend=<slug>" and
 * stops there; the client cannot offer the slugs it found without a second
 * request, and it must not be asked to parse them out of the message. The
 * kit's error options carry only `retryable`/`expose`/`cause`, so the
 * machine-readable half rides on a subclass whose `details`
 * `BaseRoute.toErrorResponse` already spreads into the body.
 */
class AmbiguousBackendError extends ConflictError {
  public readonly details: { backends: string[] };

  constructor(backends: string[]) {
    super('Multiple backends match; retry with ?backend=<slug>');
    this.details = { backends };
  }
}

function selectBackend(backends: RoutableBackend[], explicitSlug: string | null, what = 'backend'): RoutableBackend {
  const resolved = resolveBackend(backends, explicitSlug);
  if (resolved.kind === 'not-found') {
    // Distinct from "ambiguous": the caller named a backend that is not theirs,
    // or has none. The message is intentionally vague so it cannot be used to
    // enumerate another tenant's slugs.
    throw new NotFoundError(`No ${what} matches this request`);
  }
  if (resolved.kind === 'ambiguous') {
    // The candidate slugs are machine-readable context the client needs but the
    // translated message must not absorb, so they ride on a local subclass. The
    // kit's error options carry only retryable/expose/cause — there is no slot
    // for an application payload — and `BaseRoute.toErrorResponse` already
    // spreads a conflict error's `details` into the body.
    throw new AmbiguousBackendError(resolved.backends.map((b) => b.slug));
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

export { AmbiguousBackendError, selectBackend, explicitBackendSlug };
