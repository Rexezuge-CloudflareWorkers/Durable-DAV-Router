import { ErrorCode, ServiceError } from './IServiceError';

/**
 * The request conflicts with the current state.
 *
 * `details` carries machine-readable context (for example the candidate slugs
 * behind an ambiguous selector) so a handler can surface it next to the message
 * without re-deriving it. It is deliberately *not* part of `getErrorMessage`:
 * the message is the stable, translated string a client matches on, and
 * appending a variable list to it would break that.
 */
class ConflictError extends ServiceError {
  public readonly details: Record<string, unknown>;

  constructor(message?: string, details: Record<string, unknown> = {}) {
    super(message ?? 'The request conflicts with the current state of the resource.');
    this.details = details;
  }

  public getErrorCode(): ErrorCode {
    return 409;
  }

  public getErrorType(): string {
    return 'Conflict';
  }

  public getErrorMessage(): string {
    return this.message;
  }
}

export { ConflictError };
