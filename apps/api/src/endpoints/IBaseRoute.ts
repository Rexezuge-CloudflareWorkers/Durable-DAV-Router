import type { Context } from 'hono';
import { ConflictError } from '@durable-dav-router/backend-errors';
import { ErrorSanitizationUtil, canonicalizeLanguageTag } from '@durable-dav-router/shared/utils';
import { createRequestScope } from '@durable-dav-router/backend-services/composition';
import { getRequestScope, asScopedContext } from '@durable-dav-router/backend-runtime/di';
import { mapServiceError } from '@durable-dav-router/backend-services/errors';

type HonoContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

/**
 * Route helpers for the Hono app.
 *
 * Every route is a `registerX(app)` closure rather than a class, so this is a
 * namespace of statics rather than a template-method base — the error mapping
 * and scope resolution still need exactly one implementation each, and that is
 * what this provides.
 *
 * Backend `Message` stays English for domain errors; only the masked 5xx path
 * localizes, since a client seeing an opaque internal error gains nothing from
 * a translated one.
 */
abstract class BaseRoute {
  /**
   * Single-scope resolution. Prefers the per-request container installed by
   * `scopeMiddleware`; falls back to a fresh scope for call sites outside
   * middleware ordering (tests, startup helpers).
   */
  public static getScope(c: { get(key: string): unknown; env: unknown }): ReturnType<typeof createRequestScope> {
    try {
      return getRequestScope(asScopedContext(c));
    } catch {
      return createRequestScope(c.env as Env);
    }
  }

  /**
   * Strict JSON body reader. Distinguishes malformed JSON (`malformed: true`)
   * from a valid empty object — callers must return 400 on malformed instead
   * of collapsing to `{}` and surfacing a misleading `required` error — and
   * rejects an oversized body before it is buffered.
   */
  public static async readJson<T>(
    c: HonoContext | Context | { req: { json: () => Promise<unknown>; header?: (name: string) => string | undefined } },
  ): Promise<{ malformed: boolean; oversized: boolean; body: T }> {
    try {
      const contentLength = (() => {
        try {
          const header = (c as { req?: { header?: (n: string) => string | undefined } }).req?.header;
          const raw = typeof header === 'function' ? header('content-length') : undefined;
          const n = raw === undefined ? NaN : Number(raw);
          return Number.isFinite(n) ? n : NaN;
        } catch {
          return NaN;
        }
      })();
      if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
        return { malformed: false, oversized: true, body: {} as T };
      }
      const body = (await (c as { req: { json: () => Promise<unknown> } }).req.json()) as T;
      return { malformed: false, oversized: false, body };
    } catch {
      return { malformed: true, oversized: false, body: {} as T };
    }
  }

  /**
   * Status → `Exception.Type` for direct validation returns, so a hand-written
   * error cannot drift from the canonical AWS-style envelope.
   *
   * A registry rather than a `switch`: the mapping is data, and an unknown
   * code falls through to `InternalServerError` with no `default:` branch.
   */
  private static readonly ERROR_TYPE_REGISTRY: Readonly<Record<number, string>> = {
    400: 'BadRequest',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'NotFound',
    409: 'Conflict',
    413: 'PayloadTooLarge',
    429: 'RateLimited',
  };

  public static toErrorType(status: number): string {
    return this.ERROR_TYPE_REGISTRY[status] ?? 'InternalServerError';
  }

  public static jsonError(c: HonoContext, message: string, status: number): Response;
  public static jsonError(c: HonoContext, type: string, message: string, status: number): Response;
  public static jsonError(c: HonoContext, typeOrMessage: string, messageOrStatus: string | number, status = 400): Response {
    return typeof messageOrStatus === 'number'
      ? c.json({ Exception: { Type: this.toErrorType(messageOrStatus), Message: typeOrMessage } }, messageOrStatus as 400)
      : c.json({ Exception: { Type: typeOrMessage, Message: messageOrStatus } }, status as 400);
  }

  /**
   * Map any thrown value to a response.
   *
   * Delegates the status/envelope decision to the shared mapper, which masks
   * every 5xx body and logs the cause, then adds the one thing the mapper
   * cannot know: this request's locale.
   */
  public static toErrorResponse(c: HonoContext, error: unknown): Response {
    const { status, body } = mapServiceError(error, this.resolveLocale(c));
    if (status < 500) {
      const type = body.Exception?.Type ?? 'Error';
      console.warn(`Responding with ${type}:`, ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    }
    // A typed error may carry machine-readable context — the candidate slugs
    // behind an ambiguous `?backend=` selector, for example — which the client
    // needs but must not be folded into the translated message.
    const details = error instanceof ConflictError ? error.details : undefined;
    return Response.json(details && Object.keys(details).length > 0 ? { ...body, ...details } : body, { status });
  }

  private static resolveLocale(c: HonoContext): string {
    try {
      const header = c.req.header('Accept-Language');
      if (!header) return 'en';
      const first = header.split(',', 1)[0]?.split(';', 1)[0]?.trim();
      if (!first) return 'en';
      // Canonicalize (`en_us` → `en-US`) so backend string lookup and logs see
      // one tag shape; unknown tags still fall back to `en` downstream via
      // `normalizeBackendLocale`.
      return canonicalizeLanguageTag(first);
    } catch {
      return 'en';
    }
  }
}

/**
 * Cap on a request body the router will buffer. Registration and volume
 * payloads are small; anything larger is either a mistake or an attempt to
 * exhaust the isolate, and either way does not need to be parsed.
 */
const MAX_JSON_BODY_BYTES = 1_048_576;

export { BaseRoute, MAX_JSON_BODY_BYTES };
export type { HonoContext };
