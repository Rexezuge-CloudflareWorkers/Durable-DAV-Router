import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

/**
 * `users` rows.
 *
 * `id` is the stable account key. `email` is the *anchor*: an immutable,
 * internally unique value that `router_backends.owner_email` and its foreign
 * key point at, so a registered backend keeps resolving across an address
 * change. Accounts created before migration 0004 have their real address there;
 * accounts created after it anchor on their address when it is free and on an
 * opaque value otherwise (see `UserDAO.newAnchor`), because the address is a
 * mutable attribute held in `current_email` + `user_emails`.
 *
 * `current_email` is the address the account signs in with and the one the API
 * reports. `id` and `current_email` are optional because they are present only
 * once 0004 has run; `UserIdentityService` treats a missing one as the pre-0004
 * floor rather than failing.
 */
export interface UserRow {
  id?: string | null;
  email: string;
  current_email?: string | null;
  created_at: number;
  username?: string | null;
  updated_at?: number | null;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class UserDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  /**
   * Opaque anchor for an account whose sign-in address is already held as
   * another account's anchor.
   *
   * It must be globally unique and must never be a real address: the anchor is
   * the primary key that `router_backends.owner_email`'s foreign key resolves
   * against, so a real address used here could never be re-registered by a
   * different person after the original account moved off it.
   */
  public static newAnchor(): string {
    return `anchor-${randomHex(16)}@users.invalid`;
  }

  /**
   * Opaque account id, `usr_<hex>`. Stable for the life of the account and the
   * only value that should be used as an identity.
   */
  public static newId(): string {
    return `usr_${randomHex(16)}`;
  }

  /**
   * Create an account, stamping the 0004 identity columns.
   *
   * The anchor is supplied by the caller rather than derived from the sign-in
   * address: `UserIdentityService` tries the address first — which keeps new
   * rows shaped like the pre-0004 ones — and falls back to an opaque anchor when
   * the address is already taken, so a released address stays re-claimable.
   *
   * A no-op when the anchor is already held (`ON CONFLICT(email) DO NOTHING`),
   * which is what makes that fallback safe to retry.
   */
  public async createUser(input: { id?: string | null; anchor: string; loginEmail: string; now: number }): Promise<void> {
    const id = input.id ?? UserDAO.newId();
    await this.withRetry(
      () =>
        this.database
          .prepare('INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
          .bind(input.anchor.toLowerCase(), input.now, id, input.loginEmail.toLowerCase())
          .run(),
      'create user',
    );
  }

  public async upsertUser(email: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
          .bind(email.toLowerCase(), now, UserDAO.newId(), email.toLowerCase())
          .run(),
      'upsert user',
    );
  }

  /**
   * Anchor lookup — the pre-0004 floor, and what legacy `owner_email` values
   * resolve against. Lowercase the *parameter*, never the column: a function
   * call on the column side makes the `users.email` primary-key index unusable,
   * so the query degrades to a full table scan. Every writer stores a lowercased
   * value, so matching semantics are unchanged.
   */
  public async getByEmail(email: string): Promise<UserRow | null> {
    const row = await this.database.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email.toLowerCase()).first<UserRow>();
    return row ?? null;
  }

  /**
   * Account lookup by the stable key. `idx_users_id` serves it.
   */
  public async getById(id: string): Promise<UserRow | null> {
    const row = await this.database.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(id).first<UserRow>();
    return row ?? null;
  }

  /**
   * Sign-in address lookup — what an address that identifies an account is
   * resolved with after 0004. `idx_users_current_email` serves it.
   *
   * The parameter is lowercased rather than the column, for the same reason as
   * `getByEmail`.
   */
  public async getByCurrentEmail(email: string): Promise<UserRow | null> {
    const row = await this.database.prepare('SELECT * FROM users WHERE current_email = ? LIMIT 1').bind(email.toLowerCase()).first<UserRow>();
    return row ?? null;
  }

  /**
   * Move the login address. The anchor is deliberately untouched: it is what
   * `router_backends.owner_email` and its cascade resolve against, and updating
   * it would either fail the foreign key or delete the user's backends.
   *
   * `users.updated_at` is vestigial — migration 0002 left it behind when the
   * router dropped its username concept and no code read it — so it is exactly
   * the kind of column an audit of the last change belongs in.
   */
  public async setCurrentEmail(id: string, email: string, now: number): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?').bind(email.toLowerCase(), now, id).run(),
      'set current email',
    );
  }

  public async getByEmails(emails: string[]): Promise<UserRow[]> {
    const normalized = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    // Plain `?` placeholders: `lower(?)` here would still be index-safe, but
    // normalizing once up front keeps this consistent with `getByEmail`.
    return this.selectByIn('email', normalized);
  }

  /**
   * `WHERE <column> IN (…)` in chunks of `SQLITE_MAX_VARIABLE_NUMBER`.
   *
   * D1 caps bound parameters per statement, so a bulk lookup has to page. The
   * chunk size is the documented cap rather than a tuned number: a lookup is
   * never a hot path here (`getByEmails` seeds integration fixtures and
   * `resolveOrRegister` resolves one address), so exceeding it costs nothing and
   * raising it would cost a redeploy the first time an account had 1000 emails.
   */
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
