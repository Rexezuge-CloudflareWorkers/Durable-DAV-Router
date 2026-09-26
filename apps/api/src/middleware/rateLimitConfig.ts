import type { Hono } from 'hono';
import { rateLimit } from './rateLimit';

interface RateLimitDef {
  path: string;
  windowMs: number;
  max: number;
  keyPrefix: string;
}

/**
 * Table-driven rate-limit registry.
 *
 * All buckets are per-isolate token buckets. The router is stateless — no cron
 * triggers and no Durable Objects — so there is no cross-isolate backstop;
 * these limits bound per-isolate abuse and are a speed bump, not a control.
 * Edit this table — not the worker — to tune limits.
 */
const RATE_LIMIT_DEFS: readonly RateLimitDef[] = [
  // Backend registration is the only endpoint that creates a new outbound
  // network destination, so it needs the tightest mutating-endpoint budget:
  // each accepted request also triggers a live health probe from Worker egress.
  { path: '/user/backends', windowMs: 60_000, max: 10, keyPrefix: 'backends-create' },
  { path: '/user/backends/*', windowMs: 60_000, max: 30, keyPrefix: 'backends-write' },
  { path: '/user/volumes*', windowMs: 60_000, max: 60, keyPrefix: 'volumes' },
  { path: '/user/me', windowMs: 60_000, max: 120, keyPrefix: 'user-me' },
  { path: '/:owner/:volume*', windowMs: 60_000, max: 600, keyPrefix: 'webdav' },
];

function registerRateLimits(app: Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>): void {
  for (const def of RATE_LIMIT_DEFS) {
    app.use(def.path, rateLimit({ windowMs: def.windowMs, max: def.max, keyPrefix: def.keyPrefix }));
  }
}

export { RATE_LIMIT_DEFS, registerRateLimits };
export type { RateLimitDef };
