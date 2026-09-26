# Durable-DAV-Router — Backend Data (D1/DAO Layer)

Scope: `packages/backend-data/**`. Parent index: `../../AGENTS.md`.

- All D1 access via DAOs over `D1Queryable`: `BaseDAO` (`withRetry` + `deleteRowsOlderThan`), `UserDAO` (`upsertUser`/`getByEmail` + `username`, `getByUsernameCi/setUsername`), `NamespaceDAO` (global `user` registry: `claim/claimIgnore/release/isTaken`), `RouterBackendDAO` (`getByOwnerSlug/getById/listByOwnerEmail/countByOwnerEmail/update/deleteById`, case-insensitive `slug_ci`, owner-scoped uniqueness).
- Utils: `D1Types` (`D1Queryable`), `D1Utils` (`executeD1WithRetry`), `D1ErrorClassifier` (retryable detection + `isMissingSchemaError` fail-closed helper), `UpdateClause` (`buildSetClause`).
- Migrations in `migrations/0001_router_init.sql` (baseline: `users`/`namespaces` + `router_backends`; no secrets, no volume tables); integration embeds all `*.sql` via `__INTEGRATION_MIGRATION_SQL__`.
- Router stores no credentials and runs no cron pruners; retention constants come from `ConfigurationManager`, never hardcoded in DAOs.
- Layer 2 (L0-only): import only `@durable-dav-router/shared` + `@durable-dav-router/backend-errors`; never `backend-runtime`, `backend-services`, or `apps/*` (enforced by `no-restricted-imports`).
