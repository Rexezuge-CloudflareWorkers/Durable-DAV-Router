# Durable-DAV-Router — Runtime And Configuration

Scope: Wrangler bindings, build output, env vars. Parent index: `../../../AGENTS.md`.

- Root `@durable-dav-router/monorepo`, pnpm workspaces (`apps/*`, `packages/*`).
- `apps/web/vite.config.ts` proxies `/user` → `http://localhost:8787` in dev; `closeBundle` embeds `dist/index.html` into `apps/api/src/generated/spa-shell.ts` (`SPA_HTML`) on build.
- `apps/api/wrangler.template.jsonc` is the config template — copy to `wrangler.jsonc` per deployer. The template sets `ENVIRONMENT=production` and deliberately omits `DEV_AUTH_EMAIL`/`DEMO_MODE`; deployers apply site values through the `WRANGLER_VARS_PATCH_JSON` repo variable. The committed root `wrangler.jsonc` is local-dev only (`ENVIRONMENT=development`).
- The Worker serves the SPA from `/`, `/new`, `/backends/new`, `/settings` plus `/:owner/:volume` (content-negotiated: `Accept: text/html` → shell, else backend WebDAV proxy) in `DurableDavRouterWorker`.
- Bindings: D1 `DB` + KV `CACHE` (single namespace, one closed `davRoute` domain for the owner/volume→backend lookaside via `KvCache`; stateless router: no DOs, no cron, no R2/Queues/AI bindings).
- `AppConfiguration.validate()` runs **once per isolate** on the first request and logs to `console.error`. It is the only place unsafe configuration is reported, because every failure mode it checks is silent at request time: a malformed numeric var falls back to its default, and a `TEAM_DOMAIN` typo presents as an Access outage. Call it at startup, never per request.

## Required vars (no defaults)

`POLICY_AUD`, `TEAM_DOMAIN` — Cloudflare Access JWT verification (`AccessAuthService`). No default; requests fail without them (except the `DEMO_MODE`/`DEV_AUTH_EMAIL` bypass below).

## Local-only (no default, not in `ConfigurationDefaults.ts`)

`DEV_AUTH_EMAIL` — bypasses Cloudflare Access locally. `DEMO_MODE` — authenticates as `DEMO_USER_EMAIL` without verification.

**These are only honored when `ENVIRONMENT` ∈ {`development`, `dev`, `local`, `test`}.** That set is an allow-list on purpose: a deny-list (`!== 'production'`) would enable the bypass for `staging`, `prod`, `Preview`, or a typo like `prodcution`, authenticating every unauthenticated request as a fixed identity. Do not ship either variable in a production `vars` block — `validate()` warns when one is present but inert, because that is the case one config edit from being live.

## Optional vars (defaults in `ConfigurationDefaults.ts`)

| Group  | Vars (default)                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App    | `DEBUG_MODE` (`false`), `SITE_URL` (`""`)                                                                                                                          |
| Limits | `MAX_BACKENDS_PER_USER` (`20`), `BACKEND_FETCH_TIMEOUT_MS` (`8000`), `ROUTE_CACHE_TTL_SECONDS` (`86400`) |
| SSRF   | `ALLOW_PRIVATE_BACKEND_HOSTS` (unset)                                                                                                                              |

`ALLOW_PRIVATE_BACKEND_HOSTS` gates whether a user may register a private/loopback backend origin. The router fetches `baseUrl` on the user's behalf with the user's credentials attached, so without this a user could point it at cloud metadata or a private service. Unset follows the environment: allowed outside production (so a co-located `wrangler dev` works), denied in production.

Add a new env var in `ConfigurationDefaults.ts` (+ an `AppConfiguration` method, or a section object in `config/sections/`), list it in the `ServiceEnv` interface, and read it through `EnvParser` — never inline. A var missing from `ServiceEnv` can be added without a type error and silently never reach the config layer.

## Dependency injection (`packages/backend-runtime/src/di/` + `config/`)

- `AppConfiguration` — injectable instance view over env parsing: a thin facade over the section objects (`AuthConfig`, `RouterLimits`), one method per setting. Prefer injecting it in new services; mock via constructor deps.
- `Container` — minimal Factory + Singleton DI (`bind`/`bindValue`/`get`/`resolve`/`createChild`/`dispose`). `createRequestScope(env)` in `backend-services/composition` is the standard composition root (table-driven lazy DAO wiring + service bindings; `scope.get(Tokens.X)`). `scopeMiddleware` installs a single scope per request; `BaseRoute.getScope` falls back to a fresh scope for helpers and tests.
- Helpers: `memoizeAsync` (composition-root memoization; rejections are never cached so a transient D1 failure retries rather than poisoning the request scope), `providerOf` (lift a constructed value into a `Provider<DAO>`, which is how tests substitute fakes without module mocks), `setRequestScope`/`getRequestScope` (request plumbing), `asScopedContext` (the single audited Hono→`ScopedContext` adapter — use it instead of `c as never`).
- `EnvParser` is defensive about the env shape: it is reached from fail-soft paths where `env` may be null or partial, and a `TypeError` there turns a default into a 500.
