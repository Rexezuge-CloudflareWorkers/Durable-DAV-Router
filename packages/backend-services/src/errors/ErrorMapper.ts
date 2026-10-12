import { DatabaseError, DefaultInternalServerError, ServiceError } from '@rexezuge/errors';
import type { ErrorResponse } from '@rexezuge/errors';
import type { ServiceError as ServiceErrorType } from '@rexezuge/errors';
import { toServiceError } from '@rexezuge/http';
import { getLocalizedStrings } from '@rexezuge/i18n';
import { ErrorSanitizationUtil } from '@rexezuge/shared';

interface MappedError {
  status: number;
  body: ErrorResponse;
}

function internalErrorMessage(locale?: string | null): string {
  return getLocalizedStrings(locale ?? 'en').common.internalError;
}

function buildBody(error: ServiceErrorType, locale?: string | null): ErrorResponse {
  if (error.status < 500) {
    return { Exception: { Type: error.type, Message: error.message } };
  }
  console.error('Server-side error surfaced to a request:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
  return { Exception: { Type: error.type, Message: internalErrorMessage(locale) } };
}

function mapServiceError(error: unknown, locale?: string | null): MappedError {
  if (error instanceof DatabaseError) {
    console.error('Caught database error during execution:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    return {
      status: 500,
      body: { Exception: { Type: DefaultInternalServerError.type, Message: internalErrorMessage(locale) } },
    };
  }
  if (error instanceof ServiceError) {
    return { status: error.status, body: buildBody(error, locale) };
  }
  const normalized = toServiceError(error);
  console.error('Unhandled error during execution:', ErrorSanitizationUtil.sanitizeErrorForLogging(normalized));
  return {
    status: 500,
    body: {
      Exception: {
        Type: DefaultInternalServerError.type,
        Message: internalErrorMessage(locale),
      },
    },
  };
}

const KNOWN_CLIENT_STATUSES = new Set([400, 401, 403, 404, 409, 413, 429]);

function toServiceStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 {
  const mapped = mapServiceError(error);
  return KNOWN_CLIENT_STATUSES.has(mapped.status) ? (mapped.status as 400 | 401 | 403 | 404 | 409 | 413 | 429) : 500;
}

export { mapServiceError, toServiceStatus, buildBody };
export type { MappedError };
