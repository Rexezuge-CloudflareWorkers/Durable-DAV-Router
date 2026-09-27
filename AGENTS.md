# AGENTS.md

Durable-DAV-Router: Cloudflare Workers reverse-proxy router to backend Durable-DAV instances (`@durable-dav-router/monorepo`, `pnpm@11.2.2`).

- **WebDAV proxy**: `packages/webdav` (RFC 4918 protocol surface only: `SUPPORT_METHODS`/`DAV_CLASS` + CORS helpers; zero runtime deps) — no path/XML/lock/props helpers, because the router forwards DAV bodies unparsed. No local file storage, no DO SQLite, no `dav-store`.
- **Backend href prefix mode**: a backend may anchor its `DAV:href` at `/` instead of `/owner/volume` (RFC 4918 §8.3 is the default) via its per-bucket `href_prefix_mode`. The router contributes **nothing** to this and must keep contributing nothing: 207 bodies are forwarded verbatim, `rewriteDestinationForBackend` swaps only the origin so a root-anchored `Destination` keeps its path, and `/user/volumes*` is proxied unreshaped so the field rides through in both directions. The one place it cannot be correct is `parseDestinationVolume` — see the reasoning there before "fixing" it.
- **Registry**: D1 `migrations/0001_router_init.sql` baseline, `0002_router_drop_username.sql` (email-only `users`, drop `namespaces`, add the `backend_username` per-backend owner cache), `0003_router_backend_owner_email_nocase.sql` (`COLLATE NOCASE` on `owner_email`). **Never rebuild a parent table** — the `ON DELETE CASCADE` fires and D1 cannot disable FKs. `router_backends` stores a `base_url` origin only, no secrets.
- **Auth**: `/user/*` Cloudflare Access (`AccessAuthService`: DEMO→DEV→JWT→`ctx.access` fallback; never trust `Cf-Access-Authenticated-User-Email`); the DEMO/DEV bypasses are gated by an **allow-list** of dev environments, and `DEV_AUTH_EMAIL` is not in the production template. Email-only login (usernames live per-backend, same email may own different handles). Backend fan-out forwards `Cf-Access-Jwt-Assertion`/`Authorization`/`Cookie` verbatim (pure passthrough, router stores no credentials); WebDAV `/:owner/:volume/*` proxies bucket Basic verbatim, backend enforces visibility.
- **API**: `apps/api` Hono+Chanfana `DurableDavRouterWorker` (`/user/backends` CRUD with quota + liveness probe + `GET /user/backends/:slug/me` per-backend identity proxy + `GET /user/volumes` fan-out aggregated `{volumes, backends}` + `POST /user/volumes?backend=` create proxy + `GET|PATCH|DELETE /user/volumes/:owner/:volume?backend=` + `/user/volumes/:owner/:volume/*` browser/credential subpath proxy + `ALL /:owner/:volume/*` WebDAV proxy with `?backend=`/`X-Backend` disambiguation (`409` when multiples match, `405`+`Allow` for a non-DAV method) + `/user/me` (email-only) + `/health`, `/docs`). Rate limits and an unauthenticated `OPTIONS *` preflight are registered in the worker constructor.
- **Web**: `apps/web` Vite SPA (build embeds `dist/index.html` → `apps/api/src/generated/spa-shell.ts`); `GET /`, `/new`, `/backends/new`, `/settings` serve the shell, `GET /:owner/:volume` content-negotiates (`Accept: text/html` → SPA `VolumeView` with `?backend=` + `?path=` subpaths + `?tab=settings`, else WebDAV proxy); `/new` auto-loads owner from selected backend (`GET /user/backends/:slug/me`, read-only input); Dashboard groups buckets by backend with health badges. Per-bucket settings tab: General description, **Link Prefix** (`base` | `root` href anchoring, backend-owned — `HrefPrefixModeCard`), credentials, Danger Zone. The bucket browser is indifferent to the href mode: `davXml.parseMultistatus` strips the volume prefix when present and copes without it, and `davClient` builds browser-base URLs regardless.
- **Composition**: single scope per request via `scopeMiddleware` (`BaseRoute.getScope(c).get(Tokens.X)`; `createRequestScope(env)` is the composition root, table-driven DAO wiring + service bindings); `Container` + `AppConfiguration` in `@durable-dav-router/backend-runtime/di+config` are the DI foundation.
- **i18n**: backend strings in `packages/shared/src/i18n` (12 locales, `common` namespace only — the router has no repos/tokens/issues/namespaces).

## Hardening invariants

Violating any of these reintroduces a fixed vulnerability; the test suite asserts each one.

- **D1 predicates**: lowercase the _parameter_, never the column. `lower(col)` cannot use an index, so the authenticated hot path becomes a full table scan. `test/integration/api/RouterApi.int.test.ts` checks `EXPLAIN QUERY PLAN` — a wrong predicate and a right one return identical rows, so the plan is the only observable difference.
- **Probes never carry caller credentials.** The owner-routing candidate set is attacker-influenced (`backend_username` is cached from whatever a backend reports), so `buildProbeHeaders` substitutes a synthetic credential and the fan-out is capped.
- **`baseUrl` host validation.** The router fetches it with the caller's credentials and can read a response snippet back, so private/loopback/link-local hosts are rejected unless `ALLOW_PRIVATE_BACKEND_HOSTS` opts in.
- **No blanket `.catch(() => null)` on D1 reads.** Only `isMissingSchemaError` may degrade; everything else becomes a `DatabaseError`, or an outage reads as "not found".
- **5xx bodies are masked.** `ErrorMapper` logs the cause and returns a localized generic message; raw D1 text discloses the schema.
- **CORS origins are not reflected.** An allow-list is required, plus `Vary: Origin`.
- **Never replay a mutating request.** A stale cached route revalidates against D1 first; replay is restricted to idempotent methods so a consumed body is not re-sent.

## Commands

```bash
pnpm install --ignore-scripts
pnpm run checks        # typecheck + lint + god-files
pnpm -r typecheck
pnpm run lint
pnpm run test
pnpm run test:integration
pnpm run test:coverage
pnpm run validate:locales
pnpm run typegen
pnpm exec wrangler dev --config ./wrangler.jsonc
```

No committed `wrangler.jsonc` secrets. God-file guard 300/400 warn-only.
`test` is a workspace project (`test/package.json`), so `pnpm -r typecheck` and `pnpm run lint` both reach it — it sat outside the workspace while holding ~200 KB of test code, and `eslint.config.mjs` ignored `test/**` outright.
`pnpm run build` is the **only** build (just `apps/web`); re-run it after any `apps/web` change and before `wrangler deploy`. The worker serves the last local build via the gitignored `apps/api/src/generated/spa-shell.ts`, so a frontend fix is inert until the bundle is regenerated. `scripts/verify-spa-shell.mjs` runs in `checks` and rejects a missing, stubbed, or half-refreshed artifact.
Coverage floor is **64/62/63/65** (measured 65/63/64/66) — raise it, never lower it to make CI pass. It was 80/75/80/80 until `apps/web` joined the coverage `include` list, on a comment claiming a config in `apps/web` that never existed; the SPA is 44 presentational modules at ~0% needing jsdom/testing-library harnesses. Margins are ~1pp, so **new SPA code needs a test in the same change** or the gate fails. Reasoning lives in `vitest.config.mts`.

## Layers

```
shared, backend-errors, webdav → 0 deps
backend-runtime → 0 only
backend-data → 0 only
backend-services → 0-2 (not apps)
api → 0-3 + webdav (NOT backend-data values; type-only allowed)
```

## Import Direction

```
Layer 0: shared, backend-errors, webdav   — zero @durable-dav-router/* deps
Layer 1: backend-runtime                 → layer 0 only
Layer 2: backend-data                    → layer 0 only
Layer 3: backend-services                → layers 0–2 (not apps)
Layer 5: apps/api                        → layers 0–3 + webdav (NOT backend-data values; type-only allowed)
```

Enforced by ESLint `no-restricted-imports` in `eslint.config.mjs`.

## Test doubles must model the platform

A D1 double that lowercases both sides of a comparison in JS makes a wrong
predicate look right, which is how `lower(owner_email) = lower(?)` survived a full
suite — in the double it was correct, and only the query plan was wrong. Match
the platform's semantics (exact, case-sensitive) and assert `EXPLAIN QUERY PLAN`
where the difference would otherwise be invisible.

## Index

| Area                             | Guide                             |
| -------------------------------- | --------------------------------- |
| API worker, auth, routes         | `apps/api/AGENTS.md`              |
| WebDAV proxy notes               | `packages/webdav/README.md`       |
| D1/DAO layer                     | `packages/backend-data/AGENTS.md` |
| Bindings, wrangler, env vars, DI | `docs/agents/runtime/AGENTS.md`   |
| Tests, thresholds, mock patterns | `docs/agents/testing/AGENTS.md`   |

````

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
````
