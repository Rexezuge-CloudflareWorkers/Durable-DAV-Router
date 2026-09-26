import { DatabaseError } from '@durable-dav-router/backend-errors';
import { isD1ErrorRetryable } from './D1ErrorClassifier';
import type { D1Result } from './D1Types';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: (value: void) => void): unknown => setTimeout(resolve, ms));
}

/**
Exponential backoff: 100ms, 200ms, 400ms… up to `maxRetries` attempts.
*/
function backoffDelay(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * Math.pow(2, attempt);
}

async function executeD1WithRetry(
  operation: () => Promise<D1Result>,
  context: string,
  options?: { maxRetries?: number; baseDelayMs?: number },
): Promise<D1Result> {
  const maxRetries: number = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs: number = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result: D1Result = await operation();
      if (!result.success) {
        const errorMessage: string = result.error ?? 'Unknown database error';
        const retryable: boolean = isD1ErrorRetryable(errorMessage);
        if (retryable && attempt < maxRetries) {
          await sleep(backoffDelay(baseDelayMs, attempt));
          continue;
        }
        throw new DatabaseError(`Failed to ${context}: ${errorMessage}`, retryable);
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof DatabaseError) {
        if (error.retryable && attempt < maxRetries) {
          await sleep(backoffDelay(baseDelayMs, attempt));
          lastError = error;
          continue;
        }
        throw error;
      }
      if (error instanceof Error) {
        const retryable: boolean = isD1ErrorRetryable(error.message);
        if (retryable && attempt < maxRetries) {
          await sleep(backoffDelay(baseDelayMs, attempt));
          lastError = error;
          continue;
        }
        throw new DatabaseError(`Failed to ${context}: ${error.message}`, retryable);
      }
      throw error;
    }
  }

  throw lastError ?? new DatabaseError(`Failed to ${context} after ${maxRetries + 1} attempts`);
}

export { executeD1WithRetry, sleep };
