/**
 * Durable-DAV-Router environment (Value Object).
 *
 * `DB` is intentionally `unknown`: backend-runtime (Layer 1) must not import
 * backend-data (Layer 2) or `cloudflare:workers` types. Narrow it to
 * `D1Queryable` at the use site.
 *
 * `CACHE` is the single KV binding backing the `davRoute` lookaside. It is
 * optional because the router degrades to fail-soft when it is absent.
 *
 * Every variable `AppConfiguration` reads must appear here, or a new setting
 * can be added without a type error and silently never reach the config layer.
 * `ALLOW_PRIVATE_BACKEND_HOSTS` gates private/loopback backend origins and is
 * read by `BackendService`, which narrows its own env interface.
 */
interface ServiceEnv {
  DB: unknown;
  CACHE?: unknown;
  // Identity and environment
  ENVIRONMENT?: string;
  DEBUG_MODE?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  DEMO_USER_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  SITE_URL?: string;
  // Router limits
  MAX_BACKENDS_PER_USER?: string;
  BACKEND_FETCH_TIMEOUT_MS?: string;
  ROUTE_CACHE_TTL_SECONDS?: string;
  LOG_LEVEL?: string;
}

export type { ServiceEnv };
