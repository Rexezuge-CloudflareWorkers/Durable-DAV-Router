-- Migration 0002: Drop router-side username concept.
--
-- Usernames are per-backend (each Durable-DAV instance owns its own
-- globally-unique mutable username for the same email). The router keeps
-- email-only identity (`users.email`) plus a per-backend username cache
-- (`router_backends.backend_username`) used for WebDAV owner routing and
-- bucket creation auto-fill. No global username registry remains.
--
--   namespaces            dropped (backend owns usernames)
--   router_backends       + backend_username / backend_username_ci cache
--   users                 untouched (see below)
--
-- WHY `users` IS NOT REBUILT HERE
-- `router_backends.owner_email` carries `ON DELETE CASCADE` on `users(email)`
-- (see 0001). `DROP TABLE <parent>` performs an implicit `DELETE FROM parent`,
-- which fires that cascade and destroys every registered backend.
--
-- SQLite's documented table-rebuild procedure starts with
-- `PRAGMA foreign_keys = OFF`, but that escape hatch does not exist on D1:
-- D1 runs every statement inside an implicit transaction, so the pragma
-- cannot be changed mid-migration and foreign keys are always enforced.
-- Rebuilding the parent is therefore unrecoverable on D1.
--
-- The safe rule for this schema: only ever rebuild the CHILD
-- (`router_backends`, which has no children of its own). The vestigial
-- `users.username` / `users.updated_at` columns are left in place — they are
-- inert data that no code reads, and removing them is not worth the risk.

DROP TABLE IF EXISTS namespaces;

-- Per-backend username cache (nullable until first /user/me fetch).
-- `backend_username_ci` is the WebDAV owner-routing key.
ALTER TABLE router_backends ADD COLUMN backend_username TEXT;
ALTER TABLE router_backends ADD COLUMN backend_username_ci TEXT;

CREATE INDEX IF NOT EXISTS idx_router_backends_username_ci ON router_backends(backend_username_ci);
