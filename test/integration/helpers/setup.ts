import { applyMigrations } from './migrations';

/**
 * Shared setup for Durable-DAV-Router integration tests (real D1 via `SELF.fetch`).
 * Auth is `DEV_AUTH_EMAIL`-based, so `/user/*` needs no credentials.
 * Backend WebDAV traffic is proxied; tests stub `fetch` for upstream calls.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

export async function ensureAesSecret(_env: TestEnv): Promise<void> {
  // No Secrets Store binding: router stores no secrets (pure passthrough).
}

/**
 * Seed an account, stamping the migration-0004 identity columns.
 *
 * `id` and `current_email` are NOT NULL in practice, and a fixture that omits
 * them produces an account the registry cannot resolve — which reads as "the
 * user has no backends" rather than as a broken fixture. `email` stays the
 * anchor, so this matches the shape of a pre-0004 row and a post-0004 one alike.
 */
export async function ensureUser(db: D1Database, email: string, id?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const normalizedEmail = email.toLowerCase();
  const userId = id ?? `usr_${normalizedEmail.replaceAll(/[^a-z0-9]+/g, '_')}`;
  await db
    .prepare('INSERT OR IGNORE INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?)')
    .bind(normalizedEmail, now, userId, normalizedEmail)
    .run();
  await db
    .prepare('INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
    .bind(normalizedEmail, userId, now)
    .run();
  return normalizedEmail;
}

export async function setupIntegrationTest(env: TestEnv, userEmail?: string): Promise<void> {
  await applyMigrations(env.DB);
  await ensureAesSecret(env);
  if (userEmail) {
    await ensureUser(env.DB, userEmail);
  }
}

export async function seedBackend(
  db: D1Database,
  input: {
    ownerEmail: string;
    ownerUserId?: string;
    slug: string;
    baseUrl: string;
    displayName?: string | null;
    backendUsername?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ownerEmail = await ensureUser(db, input.ownerEmail, input.ownerUserId);
  // `owner_user_id` is the ownership key; `owner_email` is the frozen anchor
  // that satisfies the foreign key into `users(email)`. Both are written.
  const ownerUserId = input.ownerUserId ?? `usr_${ownerEmail.replaceAll(/[^a-z0-9]+/g, '_')}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO router_backends (id, owner_email, owner_user_id, slug, slug_ci, base_url, display_name, created_at, updated_at, backend_username, backend_username_ci) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ownerEmail,
      ownerUserId,
      input.slug,
      input.slug.toLowerCase(),
      input.baseUrl,
      input.displayName ?? null,
      now,
      now,
      input.backendUsername ?? null,
      input.backendUsername ? input.backendUsername.toLowerCase() : null,
    )
    .run();
  return id;
}

export function basicAuthHeader(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}
