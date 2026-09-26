# Durable-DAV-Router — Backend Data (D1/DAO Layer)

Scope: `packages/backend-data/**`. Parent index: `../../AGENTS.md`.

- All D1 access via DAOs over `D1Queryable`. `BaseDAO` owns exactly one thing: `withRetry` (transient-fault retry). Per-table SQL belongs in the concrete DAO.
- `UserDAO` — `upsertUser`/`getByEmail`/`getByEmails`, email-only. `RouterBackendDAO` — `create`/`createGuarded`/`getByOwnerSlug`/`getById`/`listByOwnerEmail`/`listByBackendUsernameCi`/`countByOwnerEmail`/`update`/`deleteById`.
- Utils: `D1Types` (`D1Queryable`), `D1Utils` (`executeD1WithRetry`, `sleep`), `D1ErrorClassifier` (`isD1ErrorRetryable` + `isMissingSchemaError` fail-closed helper), `UpdateClause` (`buildSetClause`, used by `RouterBackendDAO.update`).
- **D1 predicate rule**: lowercase the *parameter*, never the column. `lower(col)` cannot use an index, so it degrades the authenticated hot path to a full table scan. Every writer stores a lowercased value, so this changes no matching semantics. `test/integration/api/RouterApi.int.test.ts` asserts `EXPLAIN QUERY PLAN` directly — a wrong predicate and a right one return identical rows, so the plan is the only observable difference.
- `owner_email` is `COLLATE NOCASE` (migration 0003) and is lowercased in the DAO before binding, so the invariant does not depend on every caller remembering to normalize.
- `createGuarded` enforces uniqueness and quota in a single statement. The pre-flight `SELECT`s it replaced raced: two concurrent creates both saw a free slug, and the loser surfaced a 500 carrying the raw `UNIQUE constraint failed` text.
- Migrations: `0001_router_init.sql` (baseline), `0002_router_drop_username.sql` (drop `namespaces`, add the `backend_username` cache), `0003_router_backend_owner_email_nocase.sql` (child-only rebuild adding `COLLATE NOCASE`). Integration embeds all `*.sql` via `__INTEGRATION_MIGRATIONS__`.
- **Never rebuild a parent table.** `router_backends.owner_email` has `ON DELETE CASCADE` on `users(email)`, and `DROP TABLE <parent>` fires it. D1 runs every statement in an implicit transaction, so `PRAGMA foreign_keys = OFF` — SQLite's documented escape hatch — cannot be used. Only the child (`router_backends`, which has no children of its own) may be rebuilt. See the note in `0002`.
- Router stores no credentials and runs no cron pruners, so there is no retention/cursor/pagination helper here.
- Layer 2 (L0-only): import only `@durable-dav-router/shared` + `@durable-dav-router/backend-errors`; never `backend-runtime`, `backend-services`, or `apps/*` (enforced by `no-restricted-imports`).
