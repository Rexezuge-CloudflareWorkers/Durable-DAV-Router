-- Migration 0001: Durable-DAV-Router baseline (request router to backend Durable-DAV instances).
--
-- The router stores no file content, no dead props, no locks, and no bucket
-- credentials. Each user registers the backend Durable-DAV instances they own;
-- the router fans out `/user/volumes` reads and reverse-proxies WebDAV +
-- bucket management to the selected backend with pure passthrough auth
-- (Cloudflare Access JWT for `/user/*`, per-bucket Basic for WebDAV).
--
--   users / namespaces          identity + globally-unique usernames (same as backend)
--   router_backends             per-user backend registry (base_url only, no secrets)

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  username TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS namespaces (
  username_ci TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('user')),
  user_email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_backends (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_ci TEXT NOT NULL,
  base_url TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_status INTEGER,
  FOREIGN KEY (owner_email) REFERENCES users(email) ON DELETE CASCADE,
  UNIQUE (owner_email, slug_ci)
);

CREATE INDEX IF NOT EXISTS idx_router_backends_owner ON router_backends(owner_email);
