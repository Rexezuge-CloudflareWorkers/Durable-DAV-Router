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
 * Every variable `AppConfiguration` or `EnvParser` reads appears here, so a new
 * setting cannot be added without appearing in one place. This used to say so
 * while omitting `ALLOW_PRIVATE_BACKEND_HOSTS`, and then explained the omission in
 * the next sentence — which is how a security-relevant flag ended up absent from
 * the type an operator reads to see what the router understands. It is here now,
 * and enforced by `test/config.test.ts`.
 */
interface ServiceEnv {
  DB: unknown;
  CACHE?: unknown;
  // Identity and environment
  ENVIRONMENT?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  DEMO_USER_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  // Backend registry
  // Gates private/loopback `baseUrl` origins. Tri-state at the read site: unset
  // means "follow the environment", so it is not a boolean.
  ALLOW_PRIVATE_BACKEND_HOSTS?: string;
  // Router limits
  MAX_BACKENDS_PER_USER?: string;
  BACKEND_FETCH_TIMEOUT_MS?: string;
  ROUTE_CACHE_TTL_SECONDS?: string;
  LOG_LEVEL?: string;
}

export type { ServiceEnv };
