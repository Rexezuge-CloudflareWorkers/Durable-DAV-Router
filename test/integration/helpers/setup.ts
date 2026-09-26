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

export async function ensureUser(db: D1Database, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const normalizedEmail = email.toLowerCase();
  await db.prepare(`INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)`).bind(normalizedEmail, now).run();
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
    slug: string;
    baseUrl: string;
    displayName?: string | null;
    backendUsername?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await ensureUser(db, input.ownerEmail);
  await db
    .prepare(
      `INSERT OR IGNORE INTO router_backends (id, owner_email, slug, slug_ci, base_url, display_name, created_at, updated_at, backend_username, backend_username_ci) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.ownerEmail.toLowerCase(),
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
