import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, applyMigrationsAfter, applyMigrationsUpTo, migrationFiles } from '../helpers/migrations';

type TestEnv = Record<string, unknown> & { DB: D1Database };

const SEED_OWNER = 'owner@example.com';

/**
 * Regression suite for the migration cascade that silently deleted every
 * registered backend.
 *
 * `router_backends.owner_email` carries `ON DELETE CASCADE` on `users(email)`.
 * Migration 0002 used to rebuild `users` (the *parent*) to drop two unused
 * columns, and `DROP TABLE <parent>` performs an implicit `DELETE FROM parent`
 * — which fired the cascade and wiped `router_backends`.
 *
 * D1 cannot use SQLite's `PRAGMA foreign_keys = OFF` escape hatch (every
 * statement runs in an implicit transaction), so the only safe fix is to never
 * rebuild a parent table. These tests apply migrations to a *seeded* database
 * so a cascade is observable, which the previous "apply to an empty DB" test
 * could never detect.
 */
describe('migrations preserve registered backends', () => {
  const db = (): D1Database => (env as unknown as TestEnv).DB;

  async function countBackends(): Promise<number> {
    const row = await db().prepare('SELECT COUNT(*) AS cnt FROM router_backends').first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async function seedUserAndBackend(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await db().prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').bind(SEED_OWNER, now).run();
    await db()
      .prepare(
        `INSERT OR IGNORE INTO router_backends (id, owner_email, slug, slug_ci, base_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('seed-backend-id', SEED_OWNER, 'office', 'office', 'https://backend.example.com', now, now)
      .run();
  }

  it('lists migrations in lexical apply order', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files).toEqual([...files].sort());
    expect(files[0]).toMatch(/^0001_/);
  });

  it('does not cascade-delete router_backends when dropping the router username concept', async () => {
    // 0001 gives the baseline schema; seed a live registration.
    await applyMigrationsUpTo(db(), '0001_router_init.sql');
    await seedUserAndBackend();
    expect(await countBackends()).toBe(1);

    // Everything after 0001 must leave that row alone.
    await applyMigrationsAfter(db(), '0001_router_init.sql');
    expect(await countBackends()).toBe(1);
  });

  it('survives the full migration chain end to end', async () => {
    await applyMigrations(db());
    expect(await countBackends()).toBe(1);
  });

  it('adds the per-backend username cache columns', async () => {
    await applyMigrations(db());
    const row = await db()
      .prepare('SELECT backend_username, backend_username_ci FROM router_backends WHERE id = ?')
      .bind('seed-backend-id')
      .first<{ backend_username: string | null; backend_username_ci: string | null }>();
    expect(row).toBeTruthy();
    // Nullable until the first `/user/backends/:slug/me` fetch.
    expect(row?.backend_username).toBeNull();
    expect(row?.backend_username_ci).toBeNull();
  });

  it('drops the namespaces table (usernames are per-backend)', async () => {
    await applyMigrations(db());
    const tables = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'namespaces'")
      .all<{ name: string }>();
    expect(tables.results ?? []).toHaveLength(0);
  });

  it('enforces case-insensitive owner uniqueness and lowercases stored owner_email', async () => {
    await applyMigrations(db());
    const now = Math.floor(Date.now() / 1000);
    const before = await countBackends();

    // A case-variant owner_email for an existing slug must not create a second
    // row. `OR IGNORE` is the same shape the DAO uses, so assert on the row
    // count rather than on a thrown constraint error.
    await db()
      .prepare(
        `INSERT OR IGNORE INTO router_backends (id, owner_email, slug, slug_ci, base_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('case-variant-id', SEED_OWNER.toUpperCase(), 'office', 'office', 'https://evil.example.com', now, now)
      .run();
    expect(await countBackends()).toBe(before);

    const row = await db()
      .prepare('SELECT COUNT(*) AS cnt FROM router_backends WHERE owner_email != lower(owner_email)')
      .first<{ cnt: number }>();
    expect(row?.cnt ?? -1).toBe(0);
  });

  it('serves owner+slug lookups from an index rather than a table scan', async () => {
    await applyMigrations(db());
    // `lower(col) = lower(?)` cannot use an index, which is why the DAOs
    // lowercase the parameter instead of the column. This guards the schema
    // half of that contract.
    const plan = await db()
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM router_backends WHERE owner_email = ? AND slug_ci = ?')
      .bind(SEED_OWNER, 'office')
      .all<{ detail: string }>();
    const details = (plan.results ?? []).map((r) => r.detail).join(' | ');
    expect(details).toMatch(/USING INDEX/);
    expect(details).not.toMatch(/SCAN router_backends$/);
  });

  it('retains ON DELETE CASCADE from users to router_backends after the rebuild', async () => {
    await applyMigrations(db());
    await seedUserAndBackend();
    expect(await countBackends()).toBe(1);

    // The FK must still be armed — migration 0003 rebuilds the child table, and
    // a botched rebuild could silently drop the constraint instead.
    await db().prepare('DELETE FROM users WHERE email = ?').bind(SEED_OWNER).run();
    expect(await countBackends()).toBe(0);
  });
});
