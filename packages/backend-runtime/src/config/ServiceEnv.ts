// Shared Durable-DAV-Router service env (Value Object).
// NOTE: DB is intentionally `unknown` here — backend-runtime
// (Layer 1) must not import backend-data (Layer 2) or cloudflare:workers
// types. Narrow to D1Queryable at use sites. The router is stateless:
// no DO namespaces, no KV cache.
interface ServiceEnv {
  DB: unknown;
  DEBUG_MODE?: string;
  ENVIRONMENT?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  DEMO_USER_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  SITE_URL?: string;
  MAX_BACKENDS_PER_USER?: string;
  BACKEND_FETCH_TIMEOUT_MS?: string;
  LOG_LEVEL?: string;
}

export type { ServiceEnv };
