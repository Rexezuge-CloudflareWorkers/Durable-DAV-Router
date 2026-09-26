import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export interface UserRow {
  email: string;
  created_at: number;
}

class UserDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async upsertUser(email: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database.prepare('INSERT INTO users (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING').bind(email, now).run(),
      'upsert user',
    );
  }

  public async getByEmail(email: string): Promise<UserRow | null> {
    return this.database.prepare('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1').bind(email).first<UserRow>();
  }

  public async getByEmails(emails: string[]): Promise<UserRow[]> {
    const deduped = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const keys = [...deduped];
    if (keys.length === 0) return [];
    const out: UserRow[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const placeholders = chunk.map(() => 'lower(?)').join(', ');
      const result = await this.database
        .prepare(`SELECT * FROM users WHERE lower(email) IN (${placeholders})`)
        .bind(...chunk)
        .all<UserRow>();
      const rows = result.results ?? [];
      for (const row of rows) out.push(row);
    }
    return out;
  }
}

export { UserDAO };
