# Durable-DAV-Router — Testing

Scope: unit + integration tests. Parent index: `../../../AGENTS.md`.

Current thresholds (`vitest.config.mts`): **statements 80 / branches 75 / functions 80 / lines 80** (enforced floor; measured 87/79/89/90). Never lower a threshold to make CI pass — raise it as coverage grows.

Exclusions: `**/*.test.{ts,tsx}`, `**/*.d.ts`, `**/index.ts`, `**/types.d.ts`, `**/model/**`, plus the build-generated `apps/api/src/generated/**` blob, type-only modules (`D1Types`, `ServiceEnv`, `env.d.ts`), and re-export barrels (`dao/identity.ts`, `dao/router.ts`) — none of which have runtime behavior to exercise.

Integration in `test/integration/` uses `@cloudflare/vitest-pool-workers` and collects no coverage (the v8 provider needs `node:inspector/promises`, which does not exist inside workerd). God-file guard: `scripts/check-god-files.mjs` (soft 300 / hard 400 LOC, blocking in CI, wired into `pnpm run checks`).

## Suites

| Suite                                         | Covers                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `test/config.test.ts`                         | `EnvParser`, `RouterLimits`, `AuthConfig` environment gating, `AppConfiguration.validate()`                               |
| `test/errors.test.ts`                         | Every error class's status/type/message, `ErrorMapper` masking, `toServiceStatus`                                         |
| `test/kv.test.ts`                             | Key construction, TTL clamping, fail-soft reads/writes, paginated purge                                                   |
| `test/di.test.ts`                             | `Container` memoization/disposal/child scopes, `memoizeAsync` non-caching of rejections, request-scope plumbing           |
| `test/backend-data.test.ts`                   | `isD1ErrorRetryable` precedence, `isMissingSchemaError`, `executeD1WithRetry` backoff, `buildSetClause` ordering          |
| `test/middleware.test.ts`                     | `securityHeaders`, `rateLimit` (registration validation, buckets, fail-open, map bound), `clientIp` trust order           |
| `test/auth.test.ts`                           | `AccessAuthService` strategy chain and the bypass allow-list, `verifyAccessJwt` failure modes                             |
| `test/proxy-helpers.test.ts`                  | Header allowlists, `Destination` rewrite, byte-preserving query strip, `resolveBackend`, probe classification and fan-out |
| `test/api-routes.test.ts`                     | `/user/*` route layer over a SQL-faithful D1 double                                                                       |
| `test/user-service.test.ts`                   | Email normalization parity between `upsertUser` and `getProfileByEmail`                                                   |
| `test/logger.test.ts`, `test/worker.test.ts`  | Log levels, worker bootstrap, one-shot config validation, rate-limit wiring, preflight, error masking                     |
| `test/web-lib.test.ts`                        | `apps/web/src/lib`: API client, error decoding, formatters, DAV path helpers, `toLocalizedErrorMessage`                   |
| `test/dav-webdav.test.ts`                     | `SUPPORT_METHODS`/`DAV_CLASS`, CORS origin policy and preflight contract                                                  |
| `test/i18n.test.ts`                           | Locale bundles, structure and placeholder parity, fallback chain                                                          |
| `test/integration/api/Migrations.int.test.ts` | Migration chain against a **seeded** database: the cascade-wipe regression, FK survival, index usage                      |
| `test/integration/api/RouterApi.int.test.ts`  | End-to-end `/user/*` + DAV routing over real D1, plus `EXPLAIN QUERY PLAN` assertions                                     |

## Mock patterns

- **DAOs/services**: in-memory fakes implementing the DAO surface; assert via state, not `vi.mock`. Services take `() => Promise<DAO>` factories, so a fake is passed in through the constructor — no module mocking anywhere.
- **A D1 double must match SQLite's semantics**, not be more forgiving. A double that lowercased both sides of a comparison is exactly why `lower(owner_email) = lower(?)` survived a full suite: the predicate was wrong in SQL but right in the double, so only the _query plan_ differed. Compare exactly and case-sensitively.
- **Assert query plans where the difference is invisible in the result set.** `test/integration/api/RouterApi.int.test.ts` runs `EXPLAIN QUERY PLAN` and requires `USING INDEX` and the absence of a bare `SCAN` — the only place a plan regression is observable.
- **Don't assert a global count to prove an upper bound.** The rate-limit bucket cap is asserted as `<= MAX_BUCKETS`, which is what the invariant actually is.
- **Watch for clock and boundary sensitivity.** A formatter that floors a millisecond difference can be off by one on a bucket edge; assert the unit or a range, and confirm an apparent off-by-one is not a real bug before changing product code.
- Access auth: stub env (`DEV_AUTH_EMAIL`/`DEMO_MODE` with `ENVIRONMENT` in the allow-list); never trust `Cf-Access-Authenticated-User-Email`.
- Integration: `test/integration/vitest.config.mts` + `wrangler.test.jsonc` pool, `__INTEGRATION_MIGRATIONS__` (a per-file map, so a test can apply a prefix and seed before the rest); `helpers/setup.ts` (`setupIntegrationTest`/`ensureUser`/`seedBackend`) + `helpers/migrations.ts` (`splitSql`, `applyMigrations`/`UpTo`/`After`). Migrations are tracked per file because `ALTER TABLE ... ADD COLUMN` is not re-runnable and the D1 database is shared across a test file.
