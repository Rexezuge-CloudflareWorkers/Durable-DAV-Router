import type { Next } from 'hono';
import {
  applySecurityHeaders as applySdkSecurityHeaders,
  SECURITY_HEADERS as SDK_SECURITY_HEADERS,
  securityHeaders as sdkSecurityHeaders,
  sensitivePaths,
} from '@rexezuge/http';
import type { RouterEnv } from '@/requestContext';
import type { Context } from 'hono';

type RouterHeaderContext = Context<RouterEnv>;

const SECURITY_HEADERS = SDK_SECURITY_HEADERS;

const isSensitiveJsonPath = sensitivePaths('/user/');

function applySecurityHeaders(c: RouterHeaderContext): void {
  applySdkSecurityHeaders(c, isSensitiveJsonPath);
}

function securityHeaders(): (c: RouterHeaderContext, next: Next) => Promise<Response | void> {
  const middleware = sdkSecurityHeaders(isSensitiveJsonPath);
  return async (c: RouterHeaderContext, next: Next): Promise<Response | void> => {
    await middleware(c, next);
  };
}

export { securityHeaders, SECURITY_HEADERS, isSensitiveJsonPath, applySecurityHeaders };
