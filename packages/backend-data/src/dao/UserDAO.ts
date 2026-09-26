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
        this.database
          .prepare('INSERT INTO users (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING')
          .bind(email.toLowerCase(), now)
          .run(),
      'upsert user',
    );
  }

  public async getByEmail(email: string): Promise<UserRow | null> {
    // Lowercase the *parameter*, never the column. A function call on the column
    // side makes the `users.email` primary-key index unusable, so the query
    // degrades to a full table scan. Every writer stores a lowercased email and
    // `users.email` is `COLLATE NOCASE`, so matching semantics are unchanged.
    const row = await this.database.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email.toLowerCase()).first<UserRow>();
    return row ?? null;
  }

  public async getByEmails(emails: string[]): Promise<UserRow[]> {
    const deduped = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const keys = [...deduped];
    if (keys.length === 0) return [];
    const out: UserRow[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      // Plain `?` placeholders: `lower(?)` here would still be index-safe, but
      // normalizing once up front keeps this consistent with `getByEmail`.
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.database.prepare(`SELECT * FROM users WHERE email IN (${placeholders})`).bind(...chunk).all<UserRow>();
      const rows = result.results ?? [];
      for (const row of rows) out.push(row);
    }
    return out;
  }
}

export { UserDAO };
