-- Migration 0005: let a registered backend declare itself a replica of a live one.
--
-- The router previously had no notion of two backends being related: every
-- registered origin rendered as an independent row in the settings registry and
-- an independent section on the dashboard. A `replica_of_slug` column lets a
-- backend point at the "live" backend it mirrors, so the UI can show the live one
-- and tuck its replicas behind an expander. This is purely presentational: the
-- router still registers, proxies and fans out every backend exactly as before.
--
-- Purely additive, like 0004. The parent table is never rebuilt: rebuilding
-- `router_backends` would fire the `ON DELETE CASCADE` on `users(email)` in D1,
-- where `PRAGMA foreign_keys = OFF` is unavailable inside the implicit
-- transaction. Nothing here changes an existing column or constraint.
--
-- No self-referential FOREIGN KEY. SQLite cannot add a constraint with ALTER
-- TABLE, and a table rebuild is exactly what the migrations above forbid.
-- Referential integrity is enforced in `BackendService` instead: a replica must
-- name an existing backend of the same account, can never point at itself or at
-- another replica, and when a live backend is deleted its replicas are promoted
-- (their `replica_of_slug` is cleared) in the same service method. A stale value
-- is therefore only possible if the database was edited out of band; the UI
-- renders such a row as a standalone group rather than hiding it.

ALTER TABLE router_backends ADD COLUMN replica_of_slug TEXT;

-- Serves the owner-scoped "has this live backend got replicas?" check and the
-- promotion UPDATE on delete. Slugs are stored lowercase by `normalizeSlug`, so
-- one column is enough and lookups keep lowercasing the parameter, never the
-- column (an index-side `lower()` would turn this into a table scan).
CREATE INDEX IF NOT EXISTS idx_router_backends_replica_of ON router_backends(owner_user_id, replica_of_slug);
