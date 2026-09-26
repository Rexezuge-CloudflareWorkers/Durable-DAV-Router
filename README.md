# Durable-DAV-Router

Request router to backend Durable-DAV instances (RFC 4918 WebDAV reverse proxy on Cloudflare Workers).

- Multi-backend from day one: each user registers backend Durable-DAV origins at `/user/backends`; buckets stay at `/:owner/:volume/` and proxy to the selected backend via `?backend=<slug>` (or `X-Backend`; lone backend implicit, multiples without selector → `409`).
- Auth passthrough (router stores no secrets): Cloudflare Access JWT for `/user/*` fan-out + per-bucket Basic for WebDAV, forwarded verbatim. Each user gets up to `MAX_BACKENDS_PER_USER` (20) registered backends.
- Uniform browser UI: aggregated bucket view grouped by backend with health badges; per-bucket files/settings/credentials proxy to the owning backend through one shape.
- Only needed binding: D1 `DB` (registry only; files/props/locks live on backends).

## Quick Start

```bash
pnpm install --ignore-scripts
pnpm -r typecheck
pnpm run test
pnpm exec wrangler dev --config ./wrangler.jsonc
```

Register a backend (authenticated via Access in browser, or DEV email locally):

```bash
curl -X POST http://localhost:8787/user/backends \
  -H 'Content-Type: application/json' \
  -d '{"slug":"office","baseUrl":"https://dav.example.com"}'
```

Aggregated buckets:

```bash
curl http://localhost:8787/user/volumes
```

WebDAV via router (single backend implicit, else `?backend=office`):

```bash
curl -X PROPFIND http://localhost:8787/test/photos/?backend=office \
  -H 'Depth: 1' -u username:password
```

## Layout

- `packages/webdav/` — pure RFC 4918 proxy helpers (`SUPPORT_METHODS`, `DAV_CLASS`, CORS).
- `packages/backend-data/` — D1 DAOs (`users`/`namespaces` + `router_backends`).
- `packages/backend-services/` — `AccessAuthService` + `UserService` + `router/BackendService` + `router/BackendProxyService`.
- `apps/api/` — `DurableDavRouterWorker` front (backend CRUD, aggregated fan-out, WebDAV + browser/credential proxy, CORS, SPA shell).
- `apps/web/` — uniform SPA (aggregated Dashboard, backend management, `?backend=`-aware VolumeView).
- `migrations/0001_router_init.sql` baseline (router registry only).
- `test/router-backends.test.ts` + `test/integration/api/RouterBackends.int.test.ts` — unit + D1 integration.
