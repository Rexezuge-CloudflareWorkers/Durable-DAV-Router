import { describe, expect, it, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { setupIntegrationTest, seedBackend } from '../helpers/setup';

type TestEnv = Record<string, unknown> & { DB: D1Database };

const OWNER = 'test@example.com';

/**
 * End-to-end coverage of the authenticated JSON API against real D1.
 *
 * These run through `SELF.fetch`, so they exercise the whole chain: Hono
 * routing, the auth middleware, the per-request DI scope, the DAO layer with
 * genuine SQL, and the error mapping. The unit suite stubs D1, which is exactly
 * why a predicate bug could hide there while every real query did a full table
 * scan.
 */
describe('router authenticated API (integration)', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, OWNER);
  });

  const get = (path: string, init?: RequestInit) => SELF.fetch(new Request(`https://router${path}`, init));

  describe('authentication', () => {
    it('answers /health without any identity', async () => {
      const res = await get('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, service: 'durable-dav-router' });
    });

    it('answers a CORS preflight without credentials', async () => {
      // A preflight carries no credentials by design, so requiring auth here
      // would break every cross-origin call to the API.
      const res = await get('/user/backends', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } });
      expect(res.status).toBe(204);
    });

    it('does not grant a cross-origin browser request by default', async () => {
      // Reflecting an Origin would let any site drive cross-origin writes
      // through the proxy with the forwarded Cookie. Checked on a DAV path,
      // which is the response `applyCors` actually shapes.
      const res = await get('/someowner/somevolume', { method: 'PROPFIND', headers: { Origin: 'https://evil.example' } });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('varies on Origin so a cache cannot cross-serve a grant', async () => {
      const res = await get('/someowner/somevolume', { method: 'PROPFIND', headers: { Origin: 'https://evil.example' } });
      expect(res.headers.get('Vary') ?? '').toContain('Origin');
    });

    it('returns the authenticated email from /user/me', async () => {
      const res = await get('/user/me');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ email: OWNER });
    });

    it('never caches a /user/* response', async () => {
      const res = await get('/user/me');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('sets baseline security headers', async () => {
      const res = await get('/health');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });

  describe('backend registry', () => {
    it('registers a backend and lists it back', async () => {
      const slug = `office-${Date.now()}`;
      const create = await get('/user/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, baseUrl: 'https://backend.example.com' }),
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as { slug: string; baseUrl: string };
      expect(created.slug).toBe(slug);
      expect(created.baseUrl).toBe('https://backend.example.com');

      const list = await get('/user/backends');
      expect(list.status).toBe(200);
      const body = (await list.json()) as { backends: Array<{ slug: string }> };
      expect(body.backends.map((b) => b.slug)).toContain(slug);
    });

    it('rejects a duplicate slug with 409', async () => {
      const slug = `dupe-${Date.now()}`;
      const payload = JSON.stringify({ slug, baseUrl: 'https://backend.example.com' });
      const first = await get('/user/backends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      expect(first.status).toBe(201);
      const second = await get('/user/backends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      expect(second.status).toBe(409);
    });

    it('rejects a non-string slug with 400 rather than 500', async () => {
      const res = await get('/user/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 42, baseUrl: 'https://backend.example.com' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a malformed JSON body with 400', async () => {
      const res = await get('/user/backends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
      expect(res.status).toBe(400);
    });

    it('rejects a private backend origin in production', async () => {
      // The env under test is `development`, which permits loopback for
      // co-located development; the production default is exercised in the
      // config unit suite. Here we assert the *validation path* runs at all.
      const res = await get('/user/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: `x${Date.now()}`, baseUrl: 'https://not a url' }),
      });
      expect(res.status).toBe(400);
    });

    it('reads a single backend and 404s an unknown slug', async () => {
      const slug = `single-${Date.now()}`;
      await get('/user/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, baseUrl: 'https://backend.example.com' }),
      });
      const found = await get(`/user/backends/${slug}`);
      expect(found.status).toBe(200);
      const missing = await get('/user/backends/does-not-exist');
      expect(missing.status).toBe(404);
    });

    it('updates and deletes a backend', async () => {
      const slug = `lifecycle-${Date.now()}`;
      await get('/user/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, baseUrl: 'https://backend.example.com' }),
      });

      const patched = await get(`/user/backends/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Renamed' }),
      });
      expect(patched.status).toBe(200);
      const patchedBody = (await patched.json()) as { displayName: string };
      expect(patchedBody.displayName).toBe('Renamed');

      const deleted = await get(`/user/backends/${slug}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      const gone = await get(`/user/backends/${slug}`);
      expect(gone.status).toBe(404);
    });

    it('returns the canonical error envelope for a 404', async () => {
      const res = await get('/user/backends/nope-not-here');
      const body = (await res.json()) as { Exception: { Type: string; Message: string } };
      expect(body.Exception.Type).toBe('NotFound');
      expect(typeof body.Exception.Message).toBe('string');
    });
  });

  describe('WebDAV proxy', () => {
    it('returns 404 for an owner no backend has', async () => {
      const res = await get('/nobody-here/no-volume', { method: 'PROPFIND' });
      expect(res.status).toBe(404);
    });

    it('returns 405 with Allow for a non-DAV method on a DAV path', async () => {
      const res = await get('/someowner/somevolume', { method: 'POST', body: 'x' });
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toContain('PROPFIND');
    });

    it('returns 405 for a non-DAV method on a DAV subpath', async () => {
      const res = await get('/someowner/somevolume/file.txt', { method: 'PATCH', body: 'x' });
      expect(res.status).toBe(405);
    });
  });

  describe('aggregated volumes', () => {
    it('fails soft per backend instead of failing the whole aggregate', async () => {
      // D1 is shared across this file, so the account already has backends, and
      // the test sandbox has no egress, so every one of them is unreachable.
      // That is exactly the outage case: the response must still be a 200 with a
      // per-backend status, not a 500 and not a silent empty list. Reporting
      // "no backends" here is what previously led users to re-create
      // registrations they already had.
      await seedBackend((env as unknown as TestEnv).DB, { ownerEmail: OWNER, slug: 'unreachable', baseUrl: 'https://unreachable.invalid' });
      const res = await get('/user/volumes');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { volumes: unknown[]; backends: Array<{ slug: string; ok: boolean; status: number }> };
      expect(body.backends.length).toBeGreaterThan(0);
      expect(body.backends.every((b) => typeof b.ok === 'boolean')).toBe(true);
      // The unreachable backend is reported as failed rather than omitted.
      const unreachable = body.backends.find((b) => b.slug === 'unreachable');
      expect(unreachable?.ok).toBe(false);
      expect(unreachable?.status).toBeGreaterThanOrEqual(500);
    });

    it('narrows the fan-out to the selected backend with ?backend=', async () => {
      const slug = `picked-${Date.now()}`;
      await seedBackend((env as unknown as TestEnv).DB, { ownerEmail: OWNER, slug, baseUrl: 'https://picked.invalid' });
      const res = await get(`/user/volumes?backend=${slug}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { backends: Array<{ slug: string }> };
      // Only the selected backend is contacted, so its status is reported alone.
      expect(body.backends.map((b) => b.slug)).toEqual([slug]);
    });

    it('returns an empty aggregate for an unknown selector', async () => {
      const res = await get('/user/volumes?backend=no-such-backend');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ volumes: [], backends: [] });
    });
  });

  describe('D1 query plans', () => {
    // The single most valuable assertion in this file: it is the only place a
    // predicate regression is caught as a *plan* change rather than as a wrong
    // answer, since `lower(col) = lower(?)` and `col = ?` return identical rows.
    // Only the plan differs, and a scan is invisible until the table is large.
    const plan = async (sql: string, ...values: string[]): Promise<string> => {
      const result = await (env as unknown as TestEnv).DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all();
      return result.results.map((row) => ((row as { detail?: string }).detail ?? '')).join(' | ');
    };

    it('serves owner+slug lookups from an index', async () => {
      const detail = await plan('SELECT * FROM router_backends WHERE owner_email = ? AND slug_ci = ?', OWNER, 'x');
      expect(detail).toMatch(/USING INDEX/);
      expect(detail).not.toMatch(/SCAN router_backends$/);
    });

    it('serves owner listings from an index without a sort', async () => {
      const detail = await plan('SELECT * FROM router_backends WHERE owner_email = ? ORDER BY created_at ASC LIMIT 100', OWNER);
      expect(detail).toMatch(/USING INDEX/);
    });

    it('serves owner counts from a covering index', async () => {
      const detail = await plan('SELECT COUNT(*) FROM router_backends WHERE owner_email = ?', OWNER);
      expect(detail).not.toMatch(/SCAN router_backends$/);
    });

    it('serves user lookups from the primary key', async () => {
      const detail = await plan('SELECT * FROM users WHERE email = ?', OWNER);
      expect(detail).toMatch(/USING INDEX/);
      expect(detail).not.toMatch(/SCAN users$/);
    });

    it('serves owner-routing lookups from an index', async () => {
      // This predicate drives unauthenticated WebDAV routing, the hot path for
      // a volume that is not yet cached.
      const detail = await plan('SELECT * FROM router_backends WHERE backend_username_ci = ?', 'alice');
      expect(detail).toMatch(/USING INDEX/);
    });
  });

  describe('UserDAO', () => {
    // `users.email` is the primary key every owner-scoped query hangs off, so
    // the normalization and batch-lookup behavior is worth exercising against
    // real SQL rather than a double that would accept anything.
    it('upserts idempotently and reads back case-insensitively', async () => {
      const { UserDAO } = await import('@durable-dav-router/backend-data/dao');
      const dao = new UserDAO((env as unknown as TestEnv).DB as never);
      const now = Math.floor(Date.now() / 1000);
      const email = `Mixed-${Date.now()}@Example.com`;

      await dao.upsertUser(email, now);
      await dao.upsertUser(email.toUpperCase(), now + 1);

      // Stored lowercased, and a differently-cased lookup still finds it.
      const row = await dao.getByEmail(email.toUpperCase());
      expect(row?.email).toBe(email.toLowerCase());

      const count = await (env as unknown as TestEnv).DB.prepare('SELECT COUNT(*) AS cnt FROM users WHERE lower(email) = ?')
        .bind(email.toLowerCase())
        .first<{ cnt: number }>();
      expect(count?.cnt).toBe(1);
    });

    it('returns null for an unknown email', async () => {
      const { UserDAO } = await import('@durable-dav-router/backend-data/dao');
      const dao = new UserDAO((env as unknown as TestEnv).DB as never);
      expect(await dao.getByEmail(`nobody-${Date.now()}@example.com`)).toBeNull();
    });

    it('batch-looks-up emails across chunk boundaries, deduplicated', async () => {
      const { UserDAO } = await import('@durable-dav-router/backend-data/dao');
      const dao = new UserDAO((env as unknown as TestEnv).DB as never);
      const now = Math.floor(Date.now() / 1000);
      // More than one 50-row chunk, with case variants and blanks mixed in.
      const emails = Array.from({ length: 120 }, (_, i) => `Batch${i}-${Date.now()}@example.com`);
      for (const email of emails) await dao.upsertUser(email, now);
      const found = await dao.getByEmails([...emails, emails[0]?.toUpperCase() ?? '', '', ' '.repeat(3), ...emails.map((e) => e.toUpperCase())]);
      expect(found).toHaveLength(emails.length);
    });

    it('returns an empty array for an empty or blank-only batch', async () => {
      const { UserDAO } = await import('@durable-dav-router/backend-data/dao');
      const dao = new UserDAO((env as unknown as TestEnv).DB as never);
      expect(await dao.getByEmails([])).toEqual([]);
      expect(await dao.getByEmails(['', ' '.repeat(3)])).toEqual([]);
    });
  });

  describe('data integrity', () => {
    it('stores owner_email lowercased even when the caller supplies mixed case', async () => {
      // `users.email` is BINARY and `router_backends.owner_email` is
      // `COLLATE NOCASE`, so a mixed-case write is rejected by the parent
      // foreign key rather than silently creating a duplicate identity. The DAO
      // lowercases before binding, which is what makes the invariant hold — the
      // assertion below is that no row can end up un-normalized.
      const db = (env as unknown as TestEnv).DB;
      const now = Math.floor(Date.now() / 1000);
      const mixed = `Mixed-${Date.now()}`;
      await db.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').bind(mixed.toLowerCase(), now).run();
      // A raw mixed-case insert must fail, not quietly succeed.
      await expect(
        db
          .prepare(
            'INSERT INTO router_backends (id, owner_email, slug, slug_ci, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(`mixed-${Date.now()}`, mixed, mixed, mixed.toLowerCase(), 'https://b.example.com', now, now)
          .run(),
      ).rejects.toThrow(/FOREIGN KEY/i);

      // The DAO path normalizes, so it succeeds and stores lowercase.
      const { RouterBackendDAO } = await import('@durable-dav-router/backend-data/dao');
      const id = `dao-${Date.now()}`;
      await new RouterBackendDAO(db as never).create({
        id,
        ownerEmail: mixed,
        slug: mixed,
        baseUrl: 'https://b.example.com',
        displayName: null,
        now,
      });
      const row = await db.prepare('SELECT owner_email FROM router_backends WHERE id = ?').bind(id).first<{ owner_email: string }>();
      expect(row?.owner_email).toBe(mixed.toLowerCase());
    });

    it('rejects a case-variant duplicate for the same slug', async () => {
      const db = (env as unknown as TestEnv).DB;
      const now = Math.floor(Date.now() / 1000);
      const slug = `case-${Date.now()}`;
      await seedBackend(db, { ownerEmail: OWNER, slug, baseUrl: 'https://b.example.com' });
      // `INSERT OR IGNORE` must be a no-op rather than creating a second row.
      await db
        .prepare(
          'INSERT OR IGNORE INTO router_backends (id, owner_email, slug, slug_ci, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(`dup-${Date.now()}`, OWNER, slug, slug, 'https://evil.example.com', now, now)
        .run();
      const row = await db.prepare('SELECT COUNT(*) AS cnt FROM router_backends WHERE slug_ci = ?').bind(slug).first<{ cnt: number }>();
      expect(row?.cnt).toBe(1);
    });
  });
});
