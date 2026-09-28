import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, applyMigrationsAfter, applyMigrationsUpTo, migrationFiles } from '../helpers/migrations';

type TestEnv = Record<string, unknown> & { DB: D1Database };

const IDENTITY = '0004_router_user_identity.sql';

/**
 * Migration 0004: the email address stops being the user identifier.
 *
 * Before it, `users.email` was the primary key *and* the ownership key of the
 * router's only user-scoped table, so an address could not be changed:
 * `router_backends.owner_email` carries `ON DELETE CASCADE` on `users(email)`.
 * Rewriting the address would either trip that foreign key or, once repointed,
 * cascade the user's registered backends out of the database.
 *
 * D1 cannot use SQLite's `PRAGMA foreign_keys = OFF` escape hatch — every
 * statement runs in an implicit transaction — so rebuilding the parent table is
 * unrecoverable, exactly as migrations 0002 and 0003 document. The fix is
 * therefore additive: `users.email` becomes a frozen *anchor* and a stable
 * `users.id` becomes the identity.
 *
 * These tests apply the migrations to a **seeded** database, because every
 * property worth asserting here is invisible on an empty one — the previous
 * "apply to an empty DB" test could not have detected a cascade wipe, a lost
 * row, or a failed backfill.
 *
 * Each test seeds its own uniquely-named accounts. The D1 database is shared
 * across the tests in a file and the migration helper is idempotent, so a fixed
 * fixture would let one test's deletes decide another's outcome.
 */
describe('migration 0004 decouples the identifier from the address', () => {
  const db = (): D1Database => (env as unknown as TestEnv).DB;
  const now = (): number => Math.floor(Date.now() / 1000);

  /**
  A per-test unique suffix, so no two tests share an account.

  `crypto.getRandomValues` rather than `Math.random`: these values become primary
  keys and registry rows, and a predictable generator in a fixture is exactly the
  habit that later gets copied into a real id.
  */
  function uniq(tag: string): string {
    return `${tag}-${hex(6)}@example.com`;
  }

  /**
  A fresh opaque account id, in the production `usr_<hex>` shape.
  */
  function newAccountId(): string {
    return `usr_${hex(16)}`;
  }

  function hex(bytes: number): string {
    return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Whether 0004 has run yet.
   *
   * The database is shared across the tests in a file and the migration helper
   * is idempotent, so a test cannot assume which side of the boundary it starts
   * on. Seeding has to adapt: a row written *before* 0004 legitimately has no
   * `id`/`current_email`/`owner_user_id` (the backfill is what supplies them),
   * while a row written after must carry them, exactly as the DAOs do.
   */
  async function isUpgraded(): Promise<boolean> {
    const users = await db().prepare('PRAGMA table_info(users)').all<{ name: string }>();
    return (users.results ?? []).some((c) => c.name === 'id');
  }

  /**
   * Seed two accounts with backends under their own addresses.
   *
   * A slug is repeated across both accounts, so ownership is proven to be the id
   * rather than "the only slug that matched".
   */
  async function seedAccounts(tag: string): Promise<{ owner: string; other: string; ids: string[] }> {
    const t = now();
    const owner = uniq(`${tag}-owner`);
    const other = uniq(`${tag}-other`);
    const userId = (email: string): string => `usr_${email.replaceAll(/[^a-z0-9]+/g, '_')}`;
    const upgraded = await isUpgraded();
    for (const email of [owner, other]) {
      const insert = upgraded
        ? 'INSERT OR IGNORE INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?)'
        : 'INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)';
      const values = upgraded ? [email, t, userId(email), email] : [email, t];
      await db()
        .prepare(insert)
        .bind(...(values as string[]))
        .run();
    }
    if (upgraded) {
      // An account created *after* 0004 also gets a verified registry row, which
      // is what makes its address sign in. Without this, an account seeded after
      // the migration would exist but never resolve — which is exactly the
      // fixture bug this helper exists to avoid.
      for (const email of [owner, other]) {
        await db()
          .prepare('INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
          .bind(email, userId(email), t)
          .run();
      }
    }
    const ids: string[] = [];
    for (const [id, email, slug] of [
      [`${tag}-1`, owner, 'office'],
      [`${tag}-2`, owner, 'home'],
      [`${tag}-3`, other, 'office'],
    ] as const) {
      const insert = upgraded
        ? `INSERT OR IGNORE INTO router_backends (id, owner_email, owner_user_id, slug, slug_ci, base_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT OR IGNORE INTO router_backends (id, owner_email, slug, slug_ci, base_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`;
      const values = upgraded
        ? [id, email, userId(email), slug, slug.toLowerCase(), `https://${id}.example.com`, t, t]
        : [id, email, slug, slug.toLowerCase(), `https://${id}.example.com`, t, t];
      await db()
        .prepare(insert)
        .bind(...(values as string[]))
        .run();
      ids.push(id);
    }
    return { owner, other, ids };
  }

  /**
   * Ids only, and no `owner_user_id` column in the projection: this is also used
   * *before* 0004 has run, where that column does not exist yet.
   */
  async function backendIds(ownerEmail: string): Promise<string[]> {
    const result = await db()
      .prepare('SELECT id FROM router_backends WHERE owner_email = ? ORDER BY id')
      .bind(ownerEmail)
      .all<{ id: string }>();
    return (result.results ?? []).map((r) => r.id);
  }

  it('lists 0004 in lexical apply order', () => {
    const files = migrationFiles();
    expect(files).toContain(IDENTITY);
    expect(files).toEqual([...files].sort());
  });

  it('preserves every registered backend', async () => {
    // The invariant the whole migration exists to protect. 0002 already lost a
    // release this way when it rebuilt `users`.
    await applyMigrationsUpTo(db(), '0003_router_backend_owner_email_nocase.sql');
    const seed = await seedAccounts('preserve');
    expect(await backendIds(seed.owner)).toHaveLength(2);

    await applyMigrationsAfter(db(), '0003_router_backend_owner_email_nocase.sql');
    expect(await backendIds(seed.owner)).toEqual(seed.ids.slice(0, 2));
    expect(await backendIds(seed.other)).toEqual([seed.ids[2]]);
  });

  it('backfills a stable id and a current address for every account', async () => {
    await applyMigrations(db());
    const rows = await db().prepare('SELECT email, id, current_email FROM users ORDER BY email').all<{
      email: string;
      id: string | null;
      current_email: string | null;
    }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      expect(row.id).toMatch(/^usr_[0-9a-f]{32}$/);
      // Pre-0004 accounts anchor on their real address, so the migration copies
      // it: an account that changes address later keeps resolving.
      expect(row.current_email).toBe(row.email.toLowerCase());
    }
  });

  it('gives every account a distinct id', async () => {
    await applyMigrations(db());
    const row = await db()
      .prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS distinct_ids FROM users')
      .first<{ total: number; distinct_ids: number }>();
    expect(row?.total).toBeGreaterThan(0);
    expect(row?.distinct_ids).toBe(row?.total);
  });

  it('backfills owner_user_id on every backend, with no unknowns left', async () => {
    // A NULL here would mean "unknown actor": the row survives but no
    // owner-scoped query can find it, so the user would silently see an empty
    // dashboard. The backfill is complete *by construction* — the foreign key
    // guarantees each `owner_email` matches a `users.email`, and phase 3 keyed
    // that same value into the registry — and this asserts it rather than
    // assuming it.
    await applyMigrations(db());
    const row = await db()
      .prepare('SELECT COUNT(*) AS total, COUNT(owner_user_id) AS resolved FROM router_backends')
      .first<{ total: number; resolved: number }>();
    expect(row?.total).toBeGreaterThan(0);
    expect(row?.resolved).toBe(row?.total);
  });

  it('resolves each backend to its own account, not the other one', async () => {
    await applyMigrations(db());
    const seed = await seedAccounts('scoped');
    const rows = await db()
      .prepare(
        `SELECT rb.id, rb.owner_user_id, u.email AS anchor
         FROM router_backends rb JOIN users u ON u.id = rb.owner_user_id
         WHERE rb.id = ? OR rb.id = ? OR rb.id = ? ORDER BY rb.id`,
      )
      .bind(...seed.ids)
      .all<{ id: string; owner_user_id: string; anchor: string }>();
    const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));
    // Two accounts own a backend with the *same slug*; ownership is the id.
    expect(byId.get(seed.ids[0])?.anchor).toBe(seed.owner);
    expect(byId.get(seed.ids[1])?.anchor).toBe(seed.owner);
    expect(byId.get(seed.ids[2])?.anchor).toBe(seed.other);
    expect(byId.get(seed.ids[0])?.owner_user_id).not.toBe(byId.get(seed.ids[2])?.owner_user_id);
  });

  it('registers one verified login address per account', async () => {
    await applyMigrations(db());
    const seed = await seedAccounts('registry');
    const rows = await db()
      .prepare('SELECT email, user_id, is_verified FROM user_emails WHERE user_id IN (SELECT id FROM users WHERE email = ? OR email = ?)')
      .bind(seed.owner, seed.other)
      .all<{ email: string; user_id: string; is_verified: number }>();
    const registered = new Map((rows.results ?? []).map((r) => [r.email, r]));
    expect(registered.get(seed.owner)?.is_verified).toBe(1);
    expect(registered.get(seed.other)?.is_verified).toBe(1);
    // Lowercased, so a legacy mixed-case anchor still yields exactly one login.
    for (const row of rows.results) expect(row.email).toBe(row.email.toLowerCase());
  });

  it('leaves no dangling foreign key', async () => {
    // `PRAGMA foreign_key_check` reports violations as rows rather than raising,
    // so the migration's trailing pragma is a no-op and this is the assertion.
    await applyMigrations(db());
    const violations = await db().prepare('PRAGMA foreign_key_check').all<Record<string, unknown>>();
    expect(violations.results ?? []).toHaveLength(0);
  });

  it('keeps the ON DELETE CASCADE from users to router_backends armed', async () => {
    // 0003 rebuilds the child table, and 0004 adds a column to it. Either could
    // silently drop the constraint, and the symptom would be a deleted user
    // whose backends outlive them.
    await applyMigrations(db());
    const seed = await seedAccounts('cascade');
    expect(await backendIds(seed.owner)).toHaveLength(2);
    await db().prepare('DELETE FROM users WHERE email = ?').bind(seed.owner).run();
    expect(await backendIds(seed.owner)).toHaveLength(0);
  });

  it('serves owner-scoped lookups from an index, not a table scan', async () => {
    // The predicate rule: lowercase the *parameter*, never the column, or the
    // index is unusable. A wrong predicate and a right one return identical
    // rows, so the query plan is the only observable difference.
    await applyMigrations(db());
    const plan = await db()
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM router_backends WHERE owner_user_id = ?')
      .bind('usr_whatever')
      .all<{ detail: string }>();
    const details = (plan.results ?? []).map((r) => r.detail).join(' | ');
    expect(details).toMatch(/USING INDEX/);
    expect(details).not.toMatch(/SCAN router_backends$/);
  });

  it('serves owner+slug lookups from an index', async () => {
    await applyMigrations(db());
    const plan = await db()
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM router_backends WHERE owner_user_id = ? AND slug_ci = ?')
      .bind('usr_whatever', 'office')
      .all<{ detail: string }>();
    expect((plan.results ?? []).map((r) => r.detail).join(' | ')).toMatch(/USING INDEX/);
  });

  it('serves the id and current-email lookups from an index', async () => {
    await applyMigrations(db());
    const lookups = ['SELECT * FROM users WHERE id = ?', 'SELECT * FROM users WHERE current_email = ?'];
    for (const sql of lookups) {
      const plan = await db()
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind('usr_whatever')
        .all<{ detail: string }>();
      expect((plan.results ?? []).map((r) => r.detail).join(' | ')).toMatch(/USING INDEX/);
    }
  });

  /**
   * The behaviour this migration is for. Before it, an address was the account,
   * so a new address meant a new, empty one and the user's backends became
   * unreachable. The ops path is `scripts/change-email.ts`; the three statements
   * below are the ones it runs, in the same order — claim first so the user is
   * never locked out, revoke last.
   */
  it('keeps id-keyed backends reachable after the account changes address', async () => {
    await applyMigrations(db());
    const seed = await seedAccounts('change');
    const account = await db().prepare('SELECT id, email, current_email FROM users WHERE email = ?').bind(seed.owner).first<{
      id: string;
      email: string;
      current_email: string;
    }>();
    expect(account?.id).toBeTruthy();
    const before = await backendIds(seed.owner);
    expect(before).toHaveLength(2);

    const t = now();
    const next = uniq('change-new');
    await db()
      .prepare(
        'INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified',
      )
      .bind(next, account?.id, t)
      .run();
    await db().prepare('UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?').bind(next, t, account?.id).run();
    await db().prepare('UPDATE user_emails SET is_verified = 0 WHERE user_id = ? AND email != ?').bind(account?.id, next).run();

    // The anchor is frozen: `router_backends.owner_email` cascades from it, so
    // touching it would fail the FK or delete these rows.
    const after = await db().prepare('SELECT email FROM users WHERE id = ?').bind(account?.id).first<{ email: string }>();
    expect(after?.email).toBe(seed.owner);

    // The rows and their ownership are untouched.
    expect(await backendIds(seed.owner)).toEqual(before);
    const stillOwned = await db()
      .prepare('SELECT COUNT(*) AS cnt FROM router_backends WHERE owner_user_id = ?')
      .bind(account?.id)
      .first<{ cnt: number }>();
    expect(stillOwned?.cnt).toBe(2);

    // The old address no longer authenticates; the new one resolves to the same
    // account, so the user keeps their backends instead of getting a new, empty
    // account.
    const revoked = await db()
      .prepare('SELECT is_verified FROM user_emails WHERE email = ?')
      .bind(seed.owner)
      .first<{ is_verified: number }>();
    expect(revoked?.is_verified).toBe(0);
    const claimed = await db().prepare('SELECT user_id FROM user_emails WHERE email = ?').bind(next).first<{ user_id: string }>();
    expect(claimed?.user_id).toBe(account?.id);
  });

  it('anchors a new account opaquely when the address is still a released anchor', async () => {
    // The handover case, in the order it actually happens. `users.email` is a
    // primary key, so an address someone has moved off is still *their* anchor
    // and cannot be anchored on again; and `users.current_email` is uniquely
    // indexed, so the previous holder's sign-in address has to move first.
    //
    // That combination is why `UserIdentityService.resolveOrRegister` falls back
    // to `anchor-<hex>@users.invalid` — and therefore why the anchor is not
    // guaranteed to be a real address, and must never be reported to a client.
    await applyMigrations(db());
    const seed = await seedAccounts('handover');
    const original = await db().prepare('SELECT id FROM users WHERE email = ?').bind(seed.owner).first<{ id: string }>();
    expect(original?.id).toBeTruthy();

    const t = now();
    const movedTo = uniq('handover-moved');
    // 1. The previous holder moves off the address. Their anchor is frozen, so
    //    the row keeps `email` and only `current_email` moves. The old registry
    //    row is revoked, not deleted, so their backends stay attributable.
    await db()
      .prepare(
        'INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(email) DO UPDATE SET is_verified = excluded.is_verified',
      )
      .bind(movedTo, original?.id, t)
      .run();
    await db().prepare('UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?').bind(movedTo, t, original?.id).run();
    await db()
      .prepare('UPDATE user_emails SET is_verified = 0 WHERE user_id = ? AND email != ?')
      .bind(original?.id, movedTo)
      .run();

    // 2. The new holder signs in with the released address. Anchoring on it
    //    would collide with the previous holder's primary key, so the opaque
    //    anchor is used and the address is free to be claimed.
    const nextHolder = newAccountId();
    await db()
      .prepare('INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?)')
      .bind(`anchor-${hex(16)}@users.invalid`, t, nextHolder, seed.owner)
      .run();
    await db()
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified')
      .bind(seed.owner, nextHolder, t)
      .run();

    // The address now authenticates the new holder...
    const claimed = await db().prepare('SELECT user_id, is_verified FROM user_emails WHERE email = ?').bind(seed.owner).first<{
      user_id: string;
      is_verified: number;
    }>();
    expect(claimed?.user_id).toBe(nextHolder);
    expect(claimed?.is_verified).toBe(1);

    // ...and the previous holder's anchor, id, and backends are untouched, so
    // their registrations still cascade to them.
    const still = await db().prepare('SELECT email, current_email FROM users WHERE id = ?').bind(original?.id).first<{
      email: string;
      current_email: string;
    }>();
    expect(still?.email).toBe(seed.owner);
    expect(still?.current_email).not.toBe(seed.owner);
    expect(await backendIds(seed.owner)).toHaveLength(2);
  });
});
