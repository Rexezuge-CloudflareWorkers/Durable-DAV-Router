import { DatabaseError, DefaultInternalServerError, ServiceError } from '@durable-dav-router/backend-errors';
import type { ErrorResponse } from '@durable-dav-router/backend-errors';
import { getBackendStrings } from '@durable-dav-router/shared/i18n';
import { ErrorSanitizationUtil } from '@durable-dav-router/shared/utils';

interface MappedError {
  status: number;
  body: ErrorResponse;
}

/**
 * Central error mapper (DIP): routes convert domain errors here instead of
 * duplicating `instanceof ServiceError` switches or `.catch(() => null)`
 * existence-hiding.
 *
 * Wire shape follows the project convention: `{ "Exception": { "Type",
 * "Message" } }`.
 *
 * Every 5xx body is masked. `DatabaseError` and a 5xx `ServiceError` both carry
 * driver-level text (D1 table and column names, constraint names), and
 * `AppConfiguration.validate()` already reports the "unexpected failure" case to
 * operators, so echoing it to a client only helps an attacker map the schema.
 */
function buildBody(error: ServiceError, locale?: string | null): ErrorResponse {
  if (error.getErrorCode() < 500) {
    return { Exception: { Type: error.getErrorType(), Message: error.getErrorMessage() } };
  }
  console.error('Server-side error surfaced to a request:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
  return { Exception: { Type: error.getErrorType(), Message: internalErrorMessage(locale) } };
}

function internalErrorMessage(locale?: string | null): string {
  return getBackendStrings(locale ?? 'en').common.internalError;
}

function mapServiceError(error: unknown, locale?: string | null): MappedError {
  if (error instanceof DatabaseError) {
    console.error('Caught database error during execution:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    return {
      status: 500,
      body: { Exception: { Type: DefaultInternalServerError.getErrorType(), Message: internalErrorMessage(locale) } },
    };
  }
  if (error instanceof ServiceError) {
    return { status: error.getErrorCode(), body: buildBody(error, locale) };
  }
  console.error('Unhandled error during execution:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
  return {
    status: 500,
    body: {
      Exception: {
        Type: DefaultInternalServerError.getErrorType(),
        Message: internalErrorMessage(locale),
      },
    },
  };
}

/**
 * Collapse an error to the wire status set the JSON API uses.
 *
 * A registry rather than a branch: known client statuses pass through, and
 * everything else — including 5xx typed errors and unknown throwables — becomes
 * 500 so an unexpected failure can never be reported as a client error.
 */
const KNOWN_CLIENT_STATUSES = new Set([400, 401, 403, 404, 409, 413, 429]);

function toServiceStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 {
  const mapped = mapServiceError(error);
  return KNOWN_CLIENT_STATUSES.has(mapped.status) ? (mapped.status as 400 | 401 | 403 | 404 | 409 | 413 | 429) : 500;
}

export { mapServiceError, toServiceStatus, buildBody };
export type { MappedError };
