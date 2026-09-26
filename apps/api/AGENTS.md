# Durable-DAV-Router — API Worker

Scope: `apps/api/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — `fetch` only via `DurableDavRouterWorker` (stateless, no `scheduled`, no DO re-exports).
- `src/workers/DurableDavRouterWorker.ts` — Hono routes (no file-routing). `src/types.d.ts` — global `Env`.
- `src/workers/routes/` — `BackendRoutes` (`GET|POST /user/backends`, `GET|PATCH|DELETE /user/backends/:slug`, quota `MAX_BACKENDS_PER_USER`, origin-only `base_url`, best-effort `/health` probe) + `AggregatedVolumeRoutes` (`GET /user/volumes` fan-out with `Promise.allSettled` fail-soft per backend, `POST /user/volumes?backend=` create proxy, `GET|PATCH|DELETE /user/volumes/:owner/:volume?backend=` + `/user/volumes/:owner/:volume/*` subpath proxy for `/files/*` + `/credentials/*`) + `RouterDavProxyRoutes` (`/:owner/:volume` + `/:owner/:volume/*` for all `SUPPORT_METHODS`, `?backend=`/`X-Backend` resolution, `409 AmbiguousBackend` on collision, `Destination` rewrite, header allowlists, `AbortSignal` timeout via `BACKEND_FETCH_TIMEOUT_MS`) + `UserRoutes` (`GET /user/me`, `GET /users/:username`).
- `src/middleware/` — `MiddlewareHandlers.userAuthentication()` (`/user/*` via `AccessAuthService` + `UserService.upsertUser`).

## Auth

- `/user/*` — Cloudflare Access (`DEMO_MODE` → `DEV_AUTH_EMAIL` → JWT → `ctx.access` fallback); fan-out to backends forwards `Cf-Access-Jwt-Assertion`/`Authorization`/`Cookie` verbatim (pure passthrough, no stored secrets).
- WebDAV `/:owner/:volume/*` — proxies bucket Basic `Authorization` verbatim; backend enforces per-bucket auth. Anonymous router calls fail closed to 401 (no backend enumeration without identity).

## Routes

- Backends: `GET|POST /user/backends` · `GET|PATCH|DELETE /user/backends/:slug`.
- Volumes (aggregated): `GET /user/volumes(?backend=)` → `{volumes: [{...backend}], backends: [{slug, ok}]}` · `POST /user/volumes?backend=` · `GET|PATCH|DELETE /user/volumes/:owner/:volume?backend=` · `ALL /user/volumes/:owner/:volume/*`.
- WebDAV proxy: `OPTIONS`/`PROPFIND`/`PROPPATCH`/`MKCOL`/`GET`/`HEAD`/`PUT`/`DELETE`/`COPY`/`MOVE`/`LOCK`/`UNLOCK` on `/:owner/:volume` + `/:owner/:volume/*`.
- Users: `GET /user/me` · `GET /users/:username`.
- Public: `GET /health` (`{ok, service: 'durable-dav-router'}`) · `/docs` · SPA shell `GET /, /new, /backends/new, /settings, /:username`.

## Composition

- Single scope per request: `scopeMiddleware` installs one `Container` + `ServiceContext`; handlers resolve via `BaseRoute.getScope(c).get(Tokens.X)`.
- `src/endpoints/IBaseRoute.ts` — `BaseRoute` template (`handle()` → `handleRequest()` + `toErrorResponse()` mapping `ServiceError`; AWS envelope `{Exception:{Type,Message}}`).
- Never import `@durable-dav-router/backend-data` values in routes (type-only allowed); never import `dav-store`/`background` (deleted) — use `@durable-dav-router/backend-services/router` proxy helpers + `fetch`.
