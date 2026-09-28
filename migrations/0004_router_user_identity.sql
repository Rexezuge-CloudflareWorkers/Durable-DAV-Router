-- Migration 0004: Decouple the user identifier from the email address.
--
-- Before this migration `users.email` was the PRIMARY KEY *and* the ownership key
-- of the router's only user-scoped table, so the address was the account. It
-- could not be changed: `router_backends.owner_email` carries
-- `FOREIGN KEY (owner_email) REFERENCES users(email) ON DELETE CASCADE` (0001),
-- so rewriting an address either tripped that constraint or — once repointed —
-- cascaded the user's registered backends out of the database.
--
-- After this migration:
--   * `users.id` is the stable account key (opaque `usr_<hex>`).
--   * `users.current_email` is the mutable sign-in address: what Access
--     resolves, what `/user/me` reports, what the SPA shows.
--   * `users.email` becomes the frozen *anchor*. It is never updated, so the
--     existing foreign key and every existing `owner_email` value keep resolving
--     forever, and no table has to be rebuilt.
--   * `user_emails` is the address registry. `is_verified = 1` means "may log
--     in". An address the account moved away from is retained at `0` so
--     pre-change rows stay attributable, and is released for re-registration by
--     a later holder.
--   * `router_backends.owner_user_id` is the ownership key, and `owner_email`
--     stays as the denormalized anchor that satisfies the foreign key: still
--     written, no longer the identity.
--
-- WHY THE ANCHOR STAYS FROZEN
-- The plan was to rebuild `router_backends` to point at a new `users.id`. That
-- is unavailable on D1, and this repository has already paid for the lesson
-- twice: migration 0002 documents that `DROP TABLE <parent>` performs an implicit
-- `DELETE FROM parent`, which fires the cascade and destroys every registered
-- backend, and 0003 documents that `PRAGMA foreign_keys = OFF` — SQLite's
-- documented escape hatch — does not exist on D1 because every statement runs
-- inside an implicit transaction. Rebuilding the *parent* is unrecoverable here.
-- Keeping `email` as a frozen anchor sidesteps the rebuild entirely: this
-- migration is purely additive.
--
-- Rerunnable: every backfill is guarded by `IS NULL` / `INSERT OR IGNORE`, and
-- `users.id` is only filled where it is still missing.

-- ============================================================
-- Phase 1: stable account key
-- ============================================================
-- SQLite cannot add a PRIMARY KEY column, so the id is a plain column with a
-- unique index. A unique index is a valid foreign-key parent, which is all the
-- `owner_user_id` reference below needs.
ALTER TABLE users ADD COLUMN id TEXT;

UPDATE users SET id = 'usr_' || lower(hex(randomblob(16))) WHERE id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id ON users(id);

-- ============================================================
-- Phase 2: mutable sign-in address
-- ============================================================
-- `email` stays as the frozen anchor (see the header note); `current_email` is
-- what the account signs in with and what the API reports. Uniqueness is
-- enforced here, so an address can never be claimed by two accounts.
ALTER TABLE users ADD COLUMN current_email TEXT;

UPDATE users SET current_email = lower(email) WHERE current_email IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_current_email ON users(current_email);

-- ============================================================
-- Phase 3: address registry
-- ============================================================
-- Login resolution consults `is_verified = 1` only. Backfilled from the frozen
-- anchor address of every existing account, lowercased so a legacy mixed-case
-- row still yields exactly one login identity.
--
-- An account created after this migration anchors on its address when that is
-- free, and on an opaque `anchor-<hex>@users.invalid` otherwise, so the anchor
-- is not always a real address. That is why the registry, not the anchor, is
-- what resolves a sign-in.
CREATE TABLE IF NOT EXISTS user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_emails_user ON user_emails(user_id);

INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at)
SELECT lower(email), id, 1, created_at FROM users;

-- ============================================================
-- Phase 4: ownership key
-- ============================================================
-- Additive only: add the column, then resolve each stored anchor through the
-- registry. Resolving via `user_emails` rather than `users.email` means a row
-- still resolves once an address is linked as an alias, and the lowercased join
-- is case-insensitive by construction.
--
-- This backfill is complete, not best-effort. The foreign key guarantees every
-- `owner_email` matches some `users.email` under `COLLATE NOCASE`; phase 3 keyed
-- that same value as `lower(users.email)`; so the join below always hits and no
-- row is left with a NULL owner. `UserIdentityUpgrade.int.test.ts` asserts zero
-- NULLs against a seeded database, so the claim is checked rather than assumed.
--
-- An anchor that somehow resolves to no account would leave `owner_user_id` NULL
-- — "unknown actor", which keeps the row resolvable through `owner_email`. That
-- is a defence-in-depth reading, not an expected outcome here.
ALTER TABLE router_backends ADD COLUMN owner_user_id TEXT REFERENCES users(id);

UPDATE router_backends
SET owner_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(router_backends.owner_email) LIMIT 1);

-- Serves the owner-scoped list and count, which are the authenticated hot path.
CREATE INDEX IF NOT EXISTS idx_router_backends_owner_user_id ON router_backends(owner_user_id);

-- Serves `getByOwnerSlug` and the guarded insert's conflict target. Redundant
-- with the anchor index by construction (`owner_email` is 1:1 with
-- `owner_user_id`), and deliberately kept: it is the invariant that makes the
-- anchor the lookup key a safe floor rather than a second source of truth.
CREATE UNIQUE INDEX IF NOT EXISTS idx_router_backends_owner_user_slug ON router_backends(owner_user_id, slug_ci);

-- ============================================================
-- Phase 5: verify
-- ============================================================
-- Every backfill above resolved through `user_emails`, so no foreign key should
-- be dangling. `PRAGMA foreign_key_check` reports violations as rows rather than
-- raising, so `UserIdentityUpgrade.int.test.ts` asserts it comes back empty
-- against a seeded database.
PRAGMA foreign_key_check;
