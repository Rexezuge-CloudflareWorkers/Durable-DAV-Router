import { BaseDAO } from './BaseDAO';
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
}

class RouterBackendDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: {
    id: string;
    ownerEmail: string;
    slug: string;
    baseUrl: string;
    displayName: string | null;
    now: number;
  }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO router_backends (id, owner_email, slug, slug_ci, base_url, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(input.id, input.ownerEmail, input.slug, input.slug.toLowerCase(), input.baseUrl, input.displayName, input.now, input.now)
          .run(),
      'create router backend',
    );
  }

  public async getByOwnerSlug(ownerEmail: string, slug: string): Promise<RouterBackendRow | null> {
    const row = await this.database
      .prepare('SELECT * FROM router_backends WHERE lower(owner_email) = lower(?) AND slug_ci = ? LIMIT 1')
      .bind(ownerEmail, slug.toLowerCase())
      .first<RouterBackendRow>();
    return row ?? null;
  }

  public async getById(id: string): Promise<RouterBackendRow | null> {
    const row = await this.database.prepare('SELECT * FROM router_backends WHERE id = ? LIMIT 1').bind(id).first<RouterBackendRow>();
    return row ?? null;
  }

  public async listByOwnerEmail(ownerEmail: string, limit = 100): Promise<RouterBackendRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM router_backends WHERE lower(owner_email) = lower(?) ORDER BY created_at ASC LIMIT ?')
      .bind(ownerEmail, limit)
      .all<RouterBackendRow>();
    return result.results ?? [];
  }

  public async countByOwnerEmail(ownerEmail: string): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS cnt FROM router_backends WHERE lower(owner_email) = lower(?)')
      .bind(ownerEmail)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  public async update(
    id: string,
    patch: { baseUrl?: string; displayName?: string | null; now: number; lastSeenAt?: number | null; lastStatus?: number | null },
  ): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const bindings: unknown[] = [patch.now];
    if (patch.baseUrl !== undefined) {
      sets.push('base_url = ?');
      bindings.push(patch.baseUrl);
    }
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      bindings.push(patch.displayName);
    }
    if (patch.lastSeenAt !== undefined) {
      sets.push('last_seen_at = ?');
      bindings.push(patch.lastSeenAt);
    }
    if (patch.lastStatus !== undefined) {
      sets.push('last_status = ?');
      bindings.push(patch.lastStatus);
    }
    bindings.push(id);
    await this.withRetry(
      () => this.database.prepare(`UPDATE router_backends SET ${sets.join(', ')} WHERE id = ?`).bind(...bindings).run(),
      'update router backend',
    );
  }

  public async deleteById(id: string): Promise<void> {
    await this.withRetry(() => this.database.prepare('DELETE FROM router_backends WHERE id = ?').bind(id).run(), 'delete router backend');
  }
}

export { RouterBackendDAO };
