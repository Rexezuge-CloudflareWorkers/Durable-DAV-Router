-- Migration 0002: Drop router-side username concept.
--
-- Usernames are per-backend (each Durable-DAV instance owns its own
-- globally-unique mutable username for the same email). The router keeps
-- email-only identity (`users.email`) plus a per-backend username cache
-- (`router_backends.backend_username`) used for WebDAV owner routing and
-- bucket creation auto-fill. No global username registry remains.
--
--   users                 email-only (drop username/updated_at profile cols)
--   namespaces            dropped (backend owns usernames)
--   router_backends       + backend_username / backend_username_ci cache

DROP TABLE IF EXISTS namespaces;

-- Rebuild `users` without username columns (robust on D1 where
-- `ALTER TABLE ... DROP COLUMN` availability varies).
CREATE TABLE IF NOT EXISTS users_new (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO users_new (email, created_at)
  SELECT email, created_at FROM users;

DROP TABLE IF EXISTS users;

ALTER TABLE users_new RENAME TO users;

-- Per-backend username cache (nullable until first /user/me fetch).
-- `backend_username_ci` is the WebDAV owner-routing key.
ALTER TABLE router_backends ADD COLUMN backend_username TEXT;
ALTER TABLE router_backends ADD COLUMN backend_username_ci TEXT;

CREATE INDEX IF NOT EXISTS idx_router_backends_username_ci ON router_backends(backend_username_ci);
