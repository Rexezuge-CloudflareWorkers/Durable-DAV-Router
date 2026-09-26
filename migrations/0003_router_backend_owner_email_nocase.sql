-- Migration 0003: Case-insensitive `router_backends.owner_email`.
--
-- WHY: every DAO lookup lowercases the *parameter* and compares it against the
-- stored column (`WHERE owner_email = ?`), because `lower(col)` makes the
-- column's index unusable. That is only correct if the column is stored
-- lowercased. `RouterBackendDAO.create` used to bind `owner_email` verbatim,
-- so a caller that forgot to normalize could store `A@X.com` beside
-- `a@x.com` — two rows that `UNIQUE (owner_email, slug_ci)` failed to
-- collapse, and that the parent FK would reject outright.
--
-- `COLLATE NOCASE` makes the invariant hold at the storage layer, so
-- correctness no longer depends on every writer remembering to normalize.
--
-- This rebuilds the CHILD only. `router_backends` has no tables referencing
-- it, so `DROP TABLE router_backends` cannot cascade. `users` is the parent
-- and must never be rebuilt on D1 — see the note in 0002.
--
-- The owner-scoped uniqueness is re-established as a named unique index
-- rather than a table-level `UNIQUE` clause: the copy below lowercases
-- `owner_email`, which can collapse pre-existing case-variant rows that were
-- previously distinct. A table-level constraint would reject that copy
-- before the de-duplication statement could run.

CREATE TABLE router_backends_new (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL COLLATE NOCASE,
  slug TEXT NOT NULL,
  slug_ci TEXT NOT NULL,
  base_url TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_status INTEGER,
  backend_username TEXT,
  backend_username_ci TEXT,
  FOREIGN KEY (owner_email) REFERENCES users(email) ON DELETE CASCADE
);

INSERT INTO router_backends_new (
  id, owner_email, slug, slug_ci, base_url, display_name,
  created_at, updated_at, last_seen_at, last_status,
  backend_username, backend_username_ci
)
SELECT
  id, lower(owner_email), slug, slug_ci, base_url, display_name,
  created_at, updated_at, last_seen_at, last_status,
  backend_username, backend_username_ci
FROM router_backends;

-- Collapse any pre-existing case-variant duplicates, keeping the oldest row
-- per (owner_email, slug_ci). Duplicates could only ever have differed in
-- owner_email casing, so the survivor is an arbitrary but faithful choice.
DELETE FROM router_backends_new
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM router_backends_new GROUP BY owner_email, slug_ci
);

DROP TABLE router_backends;

ALTER TABLE router_backends_new RENAME TO router_backends;

CREATE UNIQUE INDEX IF NOT EXISTS idx_router_backends_owner_slug ON router_backends(owner_email, slug_ci);
CREATE INDEX IF NOT EXISTS idx_router_backends_owner ON router_backends(owner_email);
CREATE INDEX IF NOT EXISTS idx_router_backends_username_ci ON router_backends(backend_username_ci);

-- Fail the migration rather than commit orphaned children if the rebuild
-- somehow produced rows pointing at a missing `users` row.
PRAGMA foreign_key_check;
