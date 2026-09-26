import { BaseDAO } from './BaseDAO';
import { buildSetClause } from './UpdateClause';
import type { SetAssignment } from './UpdateClause';
import type { D1Queryable } from '../utils/D1Types';

export interface RouterBackendRow {
  id: string;
  owner_email: string;
  slug: string;
  slug_ci: string;
  base_url: string;
  display_name: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  last_status: number | null;
  backend_username: string | null;
  backend_username_ci: string | null;
}

class RouterBackendDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  // D1 predicate rule for this table: lowercase the *parameter*, never the
  // column. `lower(col)` cannot use `idx_router_backends_owner` or the
  // `(owner_email, slug_ci)` unique index, so it degrades every owner-scoped
  // lookup — the authenticated hot path — to a full table scan. `owner_email`
  // is stored lowercased and declared `COLLATE NOCASE` (migration 0003), so
  // dropping the column-side `lower()` changes no matching semantics.

  public async create(input: {
    id: string;
    ownerEmail: string;
    slug: string;
    baseUrl: string;
    displayName: string | null;
    now: number;
  }): Promise<void> {
    // Normalize here rather than trusting callers: `owner_email` is both a
    // foreign key into `users(email)` (exact-match) and part of the
    // `(owner_email, slug_ci)` uniqueness constraint, so an un-normalized write
    // is an FK violation rather than a helpful duplicate.
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO router_backends (id, owner_email, slug, slug_ci, base_url, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            input.id,
            input.ownerEmail.toLowerCase(),
            input.slug,
            input.slug.toLowerCase(),
            input.baseUrl,
            input.displayName,
            input.now,
            input.now,
          )
          .run(),
      'create router backend',
    );
  }

  /**
   * Outcome of an atomic create. `ok` means the row was inserted; the other two
   * name the constraint that rejected it, so the service can raise a precise
   * error instead of a raw database fault.
   */
  public async createGuarded(
    input: {
      id: string;
      ownerEmail: string;
      slug: string;
      baseUrl: string;
      displayName: string | null;
      now: number;
    },
    max: number,
  ): Promise<'ok' | 'duplicate' | 'quota-exceeded'> {
    // Quota and uniqueness are enforced by the database in a single statement.
    // Checking them with a preceding SELECT leaves a window in which two
    // concurrent requests both observe a free slot, and a preceding duplicate
    // check races against the unique index — in which case the loser received a
    // 500 carrying the raw D1 constraint text.
    //
    // `ON CONFLICT DO NOTHING` covers the `(owner_email, slug_ci)` index; the
    // `SELECT ... WHERE` makes the quota part of the same statement, so a
    // concurrent insert cannot overshoot it.
    const result = await this.withRetry(
      () =>
        this.database
          .prepare(
            `INSERT INTO router_backends (id, owner_email, slug, slug_ci, base_url, display_name, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE (SELECT COUNT(*) FROM router_backends WHERE owner_email = ?) < ?
             ON CONFLICT (owner_email, slug_ci) DO NOTHING`,
          )
          .bind(
            input.id,
            input.ownerEmail.toLowerCase(),
            input.slug,
            input.slug.toLowerCase(),
            input.baseUrl,
            input.displayName,
            input.now,
            input.now,
            input.ownerEmail.toLowerCase(),
            max,
          )
          .run(),
      'create router backend (guarded)',
    );
    const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
    if (changes > 0) return 'ok';
    // No row written: either the slug was taken or the quota was full. One
    // follow-up read distinguishes them so the caller reports the real cause.
    const existing = await this.getByOwnerSlug(input.ownerEmail, input.slug);
    return existing ? 'duplicate' : 'quota-exceeded';
  }

  public async getByOwnerSlug(ownerEmail: string, slug: string): Promise<RouterBackendRow | null> {
    const row = await this.database
      .prepare('SELECT * FROM router_backends WHERE owner_email = ? AND slug_ci = ? LIMIT 1')
      .bind(ownerEmail.toLowerCase(), slug.toLowerCase())
      .first<RouterBackendRow>();
    return row ?? null;
  }

  public async getById(id: string): Promise<RouterBackendRow | null> {
    const row = await this.database.prepare('SELECT * FROM router_backends WHERE id = ? LIMIT 1').bind(id).first<RouterBackendRow>();
    return row ?? null;
  }

  public async listByOwnerEmail(ownerEmail: string, limit = 100): Promise<RouterBackendRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM router_backends WHERE owner_email = ? ORDER BY created_at ASC LIMIT ?')
      .bind(ownerEmail.toLowerCase(), limit)
      .all<RouterBackendRow>();
    return result.results ?? [];
  }

  public async countByOwnerEmail(ownerEmail: string): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS cnt FROM router_backends WHERE owner_email = ?')
      .bind(ownerEmail.toLowerCase())
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  /**
   * Partial update. Only the keys present on `patch` are written, so a caller
   * updating one column does not clobber another with a default.
   *
   * `backend_username_ci` is always written alongside `backend_username` — it is
   * the WebDAV owner-routing lookup key, and leaving the two out of sync would
   * make a renamed handle unroutable.
   */
  public async update(
    id: string,
    patch: {
      baseUrl?: string;
      displayName?: string | null;
      now: number;
      lastSeenAt?: number | null;
      lastStatus?: number | null;
      backendUsername?: string | null;
    },
  ): Promise<void> {
    const assignments: SetAssignment[] = [{ column: 'updated_at', value: patch.now }];
    if (patch.baseUrl !== undefined) assignments.push({ column: 'base_url', value: patch.baseUrl });
    if (patch.displayName !== undefined) assignments.push({ column: 'display_name', value: patch.displayName });
    if (patch.lastSeenAt !== undefined) assignments.push({ column: 'last_seen_at', value: patch.lastSeenAt });
    if (patch.lastStatus !== undefined) assignments.push({ column: 'last_status', value: patch.lastStatus });
    if (patch.backendUsername !== undefined) {
      assignments.push(
        { column: 'backend_username', value: patch.backendUsername },
        { column: 'backend_username_ci', value: patch.backendUsername ? patch.backendUsername.toLowerCase() : null },
      );
    }
    const { clause, values } = buildSetClause(assignments);
    await this.withRetry(
      () =>
        this.database
          .prepare(`UPDATE router_backends SET ${clause} WHERE id = ?`)
          .bind(...values, id)
          .run(),
      'update router backend',
    );
  }

  public async listByBackendUsernameCi(usernameCi: string, limit = 100): Promise<RouterBackendRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM router_backends WHERE backend_username_ci = ? ORDER BY created_at ASC LIMIT ?')
      .bind(usernameCi.toLowerCase(), limit)
      .all<RouterBackendRow>();
    return result.results ?? [];
  }

  public async deleteById(id: string): Promise<void> {
    await this.withRetry(() => this.database.prepare('DELETE FROM router_backends WHERE id = ?').bind(id).run(), 'delete router backend');
  }
}

export { RouterBackendDAO };
