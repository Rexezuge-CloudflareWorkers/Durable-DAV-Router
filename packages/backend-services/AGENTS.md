# Durable-DAV-Router — Backend Services

Scope: `packages/backend-services/**`. Parent index: `../../AGENTS.md`. Layer 3 (may use layers 0–2 only, never apps).

- Domain map:
  - `src/auth/AccessAuthService.ts` — `/user/*` identity: `DEMO_MODE` → `DEV_AUTH_EMAIL` → JWT (`cf-access-jwt-assertion` vs `TEAM_DOMAIN`/`POLICY_AUD`) → `ctx.access.getIdentity()` fallback. Never trust `Cf-Access-Authenticated-User-Email`. The first two strategies are gated by `AppConfiguration.isBypassAllowed()`, an **allow-list** of {development, dev, local, test}.
  - `src/router/BackendService.ts` — per-user backend registry. `normalizeSlug`/`normalizeBaseUrl`/`normalizeDisplayName` validate input; `normalizeBaseUrl` returns a bare origin and **rejects private, loopback, and link-local hosts** (the router fetches this URL with the caller's credentials attached, so it is an SSRF surface). `ALLOW_PRIVATE_BACKEND_HOSTS` opts a self-hosted deployment back in; unset follows the environment. `create/get/list/update/delete` + `findBackendById` + `recordProbe` + `recordBackendUsername`/`listByBackendUsername`. Reads wrap D1 faults in `DatabaseError` via `d1Read` — only `isMissingSchemaError` degrades to a fallback, because a blanket `.catch(() => null)` turns an outage into a 404, skips the quota check, and reports zero backends.
  - `src/router/BackendProxyService.ts` — pure reverse-proxy helpers (no D1): `joinBackendUrl`, `buildProxiedHeaders` (allowlisted request headers + `Destination` rewrite), `buildProbeHeaders`, `filterProxiedResponseHeaders`, `resolveBackend`, `fetchWithTimeout`/`getProxyTimeoutMs`, `stripBackendSelector` (byte-preserving, so signed query strings survive), `classifyProbeStatus`, `probeCandidateBackends`.
  - `src/router/BackendSelection.ts` — `selectBackend` throws the typed 404/409 the shared mapper renders, instead of each route hand-building the envelope; `explicitBackendSlug` reads `?backend=` then `X-Backend`.
  - `src/router/RouteCacheService.ts` — KV `davRoute` lookaside (fail-soft, D1 authoritative): per-isolate L1 + `get/put/invalidate/purge`, credential-free keys, `single`-only caching, `parseDestinationVolume` for `MOVE`/`COPY` invalidation.
  - `src/user/UserService.ts` — email-only identity: `upsertUser` + `getProfileByEmail`. Both normalize with the same trim+lowercase; they must agree or a user is written under one key and read under another.
- `src/errors/ErrorMapper.ts` — the single place a thrown value becomes a status plus a body. **Every 5xx body is masked** and the cause logged: `DatabaseError` carries D1 table/column/constraint text, so echoing it discloses the schema.
- `src/composition/` — `Tokens` registry + `createRequestScope(env)` (`requestScope.ts`; DAO tables in `daoBindings.ts`, service wiring in `serviceBindings.ts` + `serviceBindings/coreServices.ts`, shared env/factory in `serviceFactory.ts`): per-request `Container`, table-driven lazy+memoized DAO factories, fail-soft `KvCache` from `env.CACHE`. Handlers resolve `scope.get(Tokens.X)`.
- Constructor injection: every service takes `(env, deps?)` with `() => Promise<DAO>` factories defaulting to real DAOs — tests override with fakes, no module mocks needed.
- Errors via `@durable-dav-router/backend-errors`; time/ids via `@durable-dav-router/shared/utils`.

## Security invariants worth preserving

**Probes must never carry the caller's credentials.** The owner-routing candidate set comes from `backend_username`, which is cached from whatever a backend's `/user/me` reports — so any account can register a backend claiming a victim handle and land in the victim's candidate set. `buildProbeHeaders` strips `Authorization`/`Cookie`/`Cf-Access-Jwt-Assertion` and substitutes a synthetic `router-probe:` credential, and `probeCandidateBackends` caps the fan-out at `MAX_PROBE_CANDIDATES` so one unauthenticated request cannot force unbounded egress.

**A redirect is not proof a volume exists.** A Cloudflare Access login redirect comes from a perfectly real backend; `classifyProbeStatus` returns `unknown` for 3xx so a route is not pinned to the wrong origin for the whole cache TTL.
