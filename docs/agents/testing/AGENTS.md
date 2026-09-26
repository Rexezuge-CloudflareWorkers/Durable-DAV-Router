# Durable-DAV-Router — Testing

Scope: unit + integration tests. Parent index: `../../../AGENTS.md`.

Current thresholds (`vitest.config.mts`): **statements 28 / branches 23 / functions 36 / lines 30** (enforced floor; raise toward 50/40/50/50 as coverage grows). Exclusions: `**/*.test.{ts,tsx}`, `**/*.d.ts`, `**/index.ts`, `**/types.d.ts`, `**/model/**`. Integration in `test/integration/` uses `@cloudflare/vitest-pool-workers` (no V8 coverage — no thresholds there). God-file guard: `scripts/check-god-files.mjs` (soft 300 / hard 400 LOC, blocking in CI via `continuous-integration.yml`; wired into `pnpm run checks`).
Never lower thresholds to make CI pass.

**Covered**: router registry + proxy (`test/router-backends.test.ts`: `normalizeSlug`/`normalizeBaseUrl`, `joinBackendUrl`/`rewriteDestinationForBackend`/`resolveBackend`, `BackendService` duplicate/quota with fake DAO) + shared i18n (`test/i18n.test.ts`: `getBackendStrings` locales + fallback + `formatBackendString`; web bundles via `validate_locales`) + web (`test/web-davxml.test.ts`: browser XML parser; `test/web-danger-confirm.test.tsx`), integration `RouterBackends` (`test/integration/api/RouterBackends.int.test.ts`: backend CRUD + aggregated volumes over real D1 via `SELF.fetch`; upstream fetch stubbed, health probe fail-soft).

**Mock patterns**:

- DAOs/services: in-memory fakes implementing the DAO surface with Maps/arrays; assert via state, not `vi.mock`.
- Access auth: stub env (`DEV_AUTH_EMAIL`/`DEMO_MODE`); never trust `Cf-Access-Authenticated-User-Email`.
- Integration: `test/integration/vitest.config.mts` + `wrangler.test.jsonc` pool, shared `__INTEGRATION_MIGRATION_SQL__` seeding; `helpers/setup.ts` (`setupIntegrationTest`/`ensureUser`/`seedBackend`) + `helpers/migrations.ts` (`splitSql`).
