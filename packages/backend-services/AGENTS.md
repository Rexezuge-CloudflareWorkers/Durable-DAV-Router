# Durable-DAV-Router — Backend Services

Scope: `packages/backend-services/**`. Parent index: `../../AGENTS.md`. Layer 3 (may use layers 0–2 only, never apps).

- Domain map:
  - `src/auth/AccessAuthService.ts` — `/user/*` identity: `DEMO_MODE` → `DEV_AUTH_EMAIL` → JWT (`cf-access-jwt-assertion` vs `TEAM_DOMAIN`/`POLICY_AUD`) → `ctx.access.getIdentity()` fallback. Never trust `Cf-Access-Authenticated-User-Email`.
  - `src/router/BackendService.ts` — per-user backend registry: origin-only `base_url` normalization (`normalizeSlug`/`normalizeBaseUrl`, localhost-http allowed, remote requires https), quota via injected `AppConfiguration` (`getMaxBackendsPerUser`, default 20), `create/get/list/update/delete` + `recordProbe` liveness bookkeeping.
  - `src/router/BackendProxyService.ts` — pure reverse-proxy helpers (no D1): `joinBackendUrl`, `buildProxiedHeaders` (allowlisted request headers + `Destination` rewrite), `filterProxiedResponseHeaders`, `resolveBackend` (explicit `?backend=`/`X-Backend`, lone-backend shortcut, `ambiguous` on collision), `fetchWithTimeout` via `getProxyTimeoutMs`.
  - `src/user/UserService.ts` — `upsertUser` (lowercased email, idempotent; bootstraps globally-unique `username` + `namespaces` claim) + `getProfileByEmail/getByUsername/renameUsername` (validates `USERNAME_RE`, claim-first rename with self-reclaim, old names stay reserved).
- `src/composition/` — `Tokens` registry + `createRequestScope(env)` (`requestScope.ts` orchestrator; DAO tables in `daoBindings.ts`, service wiring in `serviceBindings.ts` + `serviceBindings/coreServices.ts`, shared env/factory in `serviceFactory.ts`): per-request `Container`, table-driven lazy+memoized DAO factories, lazy `AppConfig`. Handlers resolve `scope.get(Tokens.X)`.
- Constructor injection: every service takes `(env, deps?)` with `() => Promise<DAO>` factories defaulting to real DAOs — tests override with fakes (see `test/router-backends.test.ts`), no module mocks needed.
- Errors via `@durable-dav-router/backend-errors` (`Bad/Unauthorized/Forbidden/NotFound/ConflictError`); time/ids via `@durable-dav-router/shared/utils` (`TimestampUtil`, `UUIDUtil`).
