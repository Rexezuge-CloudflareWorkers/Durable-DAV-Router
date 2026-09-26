# AGENTS.md

Durable-DAV-Router: Cloudflare Workers reverse-proxy router to backend Durable-DAV instances (`@durable-dav-router/monorepo`, `pnpm@11.2.2`).

- **WebDAV proxy**: `packages/webdav` (pure RFC 4918 `SUPPORT_METHODS`/`DAV_CLASS`/CORS helpers only, zero runtime deps except `@xmldom/xmldom`) — no local file storage, no DO SQLite, no `dav-store`.
- **Registry**: D1 `migrations/0001_router_init.sql` baseline + `0002_router_drop_username.sql` (email-only `users` + `router_backends` per-user backend registry with `base_url` origin only, no secrets, plus `backend_username` per-backend owner cache for WebDAV routing).
- **Auth**: `/user/*` Cloudflare Access (`AccessAuthService`: DEMO→DEV→JWT→`ctx.access` fallback; never trust `Cf-Access-Authenticated-User-Email`); email-only login (usernames live per-backend, same email may own different handles); backend fan-out forwards `Cf-Access-Jwt-Assertion`/`Authorization`/`Cookie` verbatim (pure passthrough, router stores no credentials); WebDAV `/:owner/:volume/*` proxies bucket Basic verbatim, backend enforces visibility.
- **API**: `apps/api` Hono+Chanfana `DurableDavRouterWorker` (`/user/backends` CRUD with quota + liveness probe + `GET /user/backends/:slug/me` per-backend identity proxy + `GET /user/volumes` fan-out aggregated `{volumes, backends}` + `POST /user/volumes?backend=` create proxy + `GET|PATCH|DELETE /user/volumes/:owner/:volume?backend=` + `/user/volumes/:owner/:volume/*` browser/credential subpath proxy + `ALL /:owner/:volume/*` WebDAV proxy with `?backend=`/`X-Backend` disambiguation (`409 AmbiguousBackend` when multiples match) + `/user/me` (email-only) + `/health`, `/docs`).
- **Web**: `apps/web` Vite SPA (build embeds `dist/index.html` → `apps/api/src/generated/spa-shell.ts`); `GET /`, `/new`, `/backends/new`, `/settings` serve the shell, `GET /:owner/:volume` content-negotiates (`Accept: text/html` → SPA `VolumeView` with `?backend=` + `?path=` subpaths + `?tab=settings`, else WebDAV proxy); `/new` auto-loads owner from selected backend (`GET /user/backends/:slug/me`, read-only input); Dashboard groups buckets by backend with health badges.
- **Composition**: single scope per request via `scopeMiddleware` (`getScope(c).get(Tokens.X)`; `createRequestScope(env)` is the composition root, table-driven DAO wiring for `UserDAO`/`RouterBackendDAO` + `BackendService` binding); `Container` + `createServiceContext` + `AppConfiguration` in `@durable-dav-router/backend-runtime/di+config` are the DI foundation.
- **i18n**: backend strings in `packages/shared/src/i18n` (wired via `BaseRoute.toErrorResponse`).

## Commands

```bash
pnpm install --ignore-scripts
pnpm -r typecheck
pnpm run lint
pnpm run test
pnpm run test:integration
pnpm run typegen
pnpm exec wrangler dev --config ./wrangler.jsonc
```

No committed `wrangler.jsonc` secrets. God-file guard 300/400 warn-only.

## Layers

```
shared, backend-errors, webdav → 0 deps (webdav may use xmldom only)
backend-runtime → 0 only
backend-data → 0 only
backend-services → 0-2 (not apps)
api → 0-3 + webdav (NOT backend-data values; type-only allowed)
```

## Import Direction

```
Layer 0: shared, backend-errors, webdav   — zero @durable-dav-router/* deps (except xmldom)
Layer 1: backend-runtime                 → layer 0 only
Layer 2: backend-data                    → layer 0 only
Layer 3: backend-services                → layers 0–2 (not apps)
Layer 5: apps/api                        → layers 0–3 + webdav (NOT backend-data values; type-only allowed)
```

Enforced by ESLint `no-restricted-imports` in `eslint.config.mjs`.

## Index

| Area                              | Guide                          |
| --------------------------------- | ------------------------------ |
| API worker, auth, routes          | `apps/api/AGENTS.md`           |
| WebDAV proxy notes                | `packages/webdav/README.md`    |
| D1/DAO layer                      | `packages/backend-data/AGENTS.md` |
| Bindings, wrangler, env vars, DI  | `docs/agents/runtime/AGENTS.md` |
| Tests, thresholds, mock patterns  | `docs/agents/testing/AGENTS.md` |
```

## Commit Policy

Always commit changes after completing work unless explicitly told not to.

## Git Commit Messages

Format: `<TYPE>[optional scope]: <description>`

- Type in UPPERCASE: `FIX`, `FEAT`, `DOCS`, `STYLE`, `REFACTOR`, `TEST`, `BUILD`, `CHORE`, `CI`, `PERF`.
- Scope in lowercase: `FEAT(runtime): Add Scheduled Job State`.
- Description: Title Case words — `DOCS: Latest Agents Context Reflection`.
- When committing from `main`, first create a branch: `type/description` or `type/scope/description` in kebab-case (e.g. `feat/bootstrap/bootstrap-jqanywhere-v0.1-framework`).
- Always include a Markdown body separated from the subject by a blank line.
- Breaking changes: `!` after type/scope, or `BREAKING CHANGE: <description>` footer.

```text
<TYPE>[optional scope]: <description>

[Markdown body]

[optional footers]
```
