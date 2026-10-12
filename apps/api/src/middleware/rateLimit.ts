import type { Context, Next } from 'hono';
import { RateLimitedError } from '@rexezuge/errors';
import { clientIp as sdkClientIp, rateLimit as sdkRateLimit } from '@rexezuge/http';
import type { RateLimitContext as SdkRateLimitContext } from '@rexezuge/http';
import type { RouterEnv } from '@/requestContext';

type RateLimitContext = Context<RouterEnv>;

function clientIp(c: RateLimitContext): string {
  return sdkClientIp((name) => c.req.header(name) ?? undefined);
}

function toSdkContext(c: RateLimitContext): SdkRateLimitContext {
  return {
    req: { header: (name: string) => c.req.header(name) ?? undefined },
    get: (key: string) => {
      if (key === 'AuthenticatedUserEmailAddress') {
        try {
          const account = (c as unknown as { get(k: string): unknown }).get('AuthenticatedAccount') as
            | { id?: unknown }
            | undefined;
          if (typeof account?.id === 'string' && account.id.length > 0) return account.id;
        } catch {
          // Fall through to IP keying below (fail open path in SDK handles it).
        }
        return undefined;
      }
      try {
        return (c as unknown as { get(k: string): unknown }).get(key);
      } catch {
        return undefined;
      }
    },
    json: (body: unknown, status?: number, headers?: Record<string, string>) =>
      (c.json as unknown as (body: unknown, status?: number, headers?: Record<string, string>) => Response)(body, status, headers),
  };
}

function rateLimit(opts: { windowMs: number; max: number; keyPrefix: string }): (c: RateLimitContext, next: Next) => Promise<Response | void> {
  const sdkMiddleware = sdkRateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    keyPrefix: opts.keyPrefix,
    onThrottled: (retryAfter, sdkCtx) => {
      const error = new RateLimitedError();
      return sdkCtx.json({ Exception: { Type: error.type, Message: error.message } }, 429, {
        'Retry-After': String(retryAfter),
      });
    },
  });
  return async (c: RateLimitContext, next: Next): Promise<Response | void> => {
    // Exactly-once dispatch. The SDK limiter's fail-open `catch` re-invokes
    // `next()` when the downstream chain rejects, which would run a mutating
    // request twice and charge it twice. This wrapper runs it once: a second
    // call rethrows the first call's error (so the rejection still propagates)
    // instead of dispatching again.
    let settled = false;
    let failure: { error: unknown } | null = null;
    const onceNext = async (): Promise<Response | void> => {
      if (failure) throw failure.error;
      if (settled) return undefined;
      settled = true;
      try {
        return (await next());
      } catch (error) {
        failure = { error };
        throw error;
      }
    };
    return sdkMiddleware(toSdkContext(c), onceNext);
  };
}

function resetRateLimitForTests(): void {
  // Buckets are per-middleware in the SDK (no shared global); each test
  // constructs a fresh limiter, so there is nothing to clear. Kept for compat.
}

function getRateLimitBucketCountForTests(): number {
  return 0;
}

export { rateLimit, resetRateLimitForTests, clientIp, getRateLimitBucketCountForTests };
