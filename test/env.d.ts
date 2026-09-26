/**
 * `cloudflare:test` is injected by `@cloudflare/vitest-pool-workers` at runtime
 * only — there is no resolvable module on disk for TypeScript to find, so an
 * integration test importing `SELF`/`env` fails to type-check. Declaring the
 * two names the suite actually uses keeps `test/integration/**` inside the
 * workspace's `pnpm -r typecheck` instead of excluded from it.
 *
 * This file deliberately does not pull in `@cloudflare/vitest-pool-workers` or
 * `@cloudflare/workers-types`. The former declares its own `cloudflare:test`
 * types, and the latter's runtime globals already come from
 * `worker-configuration.d.ts` (included by `tsconfig.json`, the same mechanism
 * `apps/api` relies on). Depending on either here would add a peer-resolved
 * entry to the lockfile for no benefit.
 */
declare module 'cloudflare:test' {
  /**
  The worker under test, addressed as a fetch handler.
  */
  export const SELF: Fetcher;
  /**
  The worker's bindings, including `DB`.
  */
  export const env: Env;
}

/**
 * Injected by `test/integration/vitest.config.mts` via `define`, containing the
 * concatenation of every `migrations/*.sql`. Declared here so the integration
 * suite type-checks like the rest of the workspace.
 */
declare const __INTEGRATION_MIGRATION_SQL__: string;
