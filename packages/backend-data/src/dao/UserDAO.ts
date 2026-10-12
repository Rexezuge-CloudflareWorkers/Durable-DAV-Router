import { UserDAO as SdkUserDAO, newAccountId, newAnchor } from '@rexezuge/identity';
import type { UserRow } from '@rexezuge/identity';

/**
 * Router `users` access: the SDK DAO plus the two router-only reads.
 *
 * Everything identity-shaped (`createUser`, `getByEmail`, `getById`,
 * `getByCurrentEmail`, `setCurrentEmail`, the anchor/id generators) lives in
 * `@rexezuge/identity`. What stays here is what the router alone needs:
 * `upsertUser`/`getByEmails` seed integration fixtures, and `newId`/`newAnchor`
 * are the historic names existing call sites use.
 */
class UserDAO extends SdkUserDAO {
  public static newId(): string {
    return newAccountId();
  }

  public static newAnchor(): string {
    return newAnchor();
  }

  public async upsertUser(email: string, now: number): Promise<void> {
    await this.run('INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      email.toLowerCase(),
      now,
      UserDAO.newId(),
      email.toLowerCase(),
    ]);
  }

  public async getByEmails(emails: string[]): Promise<UserRow[]> {
    const normalized = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    return this.selectByIn('email', normalized);
  }

  private async selectByIn(column: 'email' | 'id', values: string[]): Promise<UserRow[]> {
    const deduped = new Set(values);
    const keys = [...deduped];
    const out: UserRow[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.database.prepare(`SELECT * FROM users WHERE ${column} IN (${placeholders})`).bind(...chunk).all<UserRow>();
      const rows = result.results ?? [];
      for (const row of rows) out.push(row);
    }
    return out;
  }
}

export { UserDAO };


export {type UserRow} from '@rexezuge/identity';