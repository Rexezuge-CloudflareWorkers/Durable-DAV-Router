import { describe, expect, it, vi } from 'vitest';
import { UserService } from '@durable-dav-router/backend-services/user';
import { NotFoundError } from '@durable-dav-router/backend-errors';
import { UserIdentityService } from '@durable-dav-router/backend-services/identity';
import type { UserDAO, UserEmailDAO } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';

/**
 * `users` + `user_emails` as two maps, so the registry and the anchor table
 * cannot drift apart in the double.
 *
 * Exact, case-sensitive string matching, matching D1: the DAOs lowercase the
 * *parameter* precisely so the comparison stays exact, and a double that
 * lowercased both sides would make a wrong predicate look right.
 */
function fakeIdentityDao(seed: Array<{ email: string; id?: string }> = []) {
  const users = new Map<string, { id: string; email: string; current_email: string; created_at: number }>();
  for (const row of seed) {
    const email = row.email.toLowerCase();
    users.set(email, { id: row.id ?? `usr_${email}`, email, current_email: email, created_at: 1 });
  }
  const emails = new Map<string, { email: string; user_id: string; is_verified: number; created_at: number }>();
  for (const row of seed) {
    const email = row.email.toLowerCase();
    const id = row.id ?? `usr_${email}`;
    emails.set(email, { email, user_id: id, is_verified: 1, created_at: 1 });
  }
  return { users, emails };
}

const svc = (seed: Array<{ email: string; id?: string }> = []) => {
  const { users, emails } = fakeIdentityDao(seed);
  const userDAO = {
    createUser: vi.fn(async (input: { id?: string | null; anchor: string; loginEmail: string; now: number }) => {
      const anchor = input.anchor.toLowerCase();
      if (users.has(anchor)) return;
      const id = input.id ?? `usr_${anchor}`;
      users.set(anchor, { id, email: anchor, current_email: input.loginEmail.toLowerCase(), created_at: input.now });
    }),
    getById: vi.fn(async (id: string) => [...users.values()].find((u) => u.id === id) ?? null),
    getByEmail: vi.fn(async (email: string) => users.get(email.toLowerCase()) ?? null),
    getByCurrentEmail: vi.fn(async (email: string) => [...users.values()].find((u) => u.current_email === email.toLowerCase()) ?? null),
    setCurrentEmail: vi.fn(async (id: string, email: string) => {
      const row = [...users.values()].find((u) => u.id === id);
      if (row) row.current_email = email.toLowerCase();
    }),
  };
  const userEmailDAO = {
    get: vi.fn(async (email: string) => emails.get(email.toLowerCase()) ?? null),
    resolveVerified: vi.fn(async (email: string) => {
      const row = emails.get(email.toLowerCase());
      return row?.is_verified === 1 ? row : null;
    }),
    register: vi.fn(async (input: { email: string; userId: string; isVerified: boolean; now: number }) => {
      const email = input.email.toLowerCase();
      const existing = emails.get(email);
      if (existing?.is_verified === 1) return 'already-claimed' as const;
      emails.set(email, { email, user_id: input.userId, is_verified: input.isVerified ? 1 : 0, created_at: input.now });
      return 'claimed' as const;
    }),
    listByUserId: vi.fn(async (userId: string) => [...emails.values()].filter((e) => e.user_id === userId)),
    revoke: vi.fn(async (email: string) => {
      const row = emails.get(email.toLowerCase());
      if (row) row.is_verified = 0;
    }),
    revokeAllVerified: vi.fn(async (userId: string, exceptEmail: string) => {
      for (const row of emails.values()) {
        if (row.user_id === userId && row.email !== exceptEmail.toLowerCase()) row.is_verified = 0;
      }
    }),
  };
  const identity = new UserIdentityService({ DB: {} as D1Queryable }, {
    userDAO: () => Promise.resolve(userDAO as unknown as UserDAO),
    userEmailDAO: () => Promise.resolve(userEmailDAO as unknown as UserEmailDAO),
  });
  return { service: new UserService({ DB: {} as D1Queryable }, { userIdentity: () => Promise.resolve(identity) }), users, emails };
};

describe('UserService.upsertUser', () => {
  it('registers an unknown address and returns its account', async () => {
    const { service, users } = svc();
    const account = await service.upsertUser('User@Example.com');
    expect(account.email).toBe('user@example.com');
    expect(account.id).toMatch(/^usr_/);
    // `users.email` is the frozen anchor, so it is stored lowercased: it is both
    // a foreign-key target and part of a uniqueness constraint.
    expect([...users.keys()]).toEqual(['user@example.com']);
  });

  it('is idempotent — a repeat sign-in returns the same account', async () => {
    const { service, users } = svc();
    const first = await service.upsertUser('user@example.com');
    const second = await service.upsertUser('user@example.com');
    expect(second.id).toBe(first.id);
    expect(users.size).toBe(1);
  });

  it('never forks a second account for a verified address', async () => {
    // The reason `upsertUser` resolves before it creates: registration keyed on
    // the address alone would hand a changed address an empty second account and
    // orphan every backend registered under the first.
    const { service, users } = svc([{ email: 'user@example.com', id: 'usr_existing' }]);
    const account = await service.upsertUser('USER@example.com');
    expect(account.id).toBe('usr_existing');
    expect(users.size).toBe(1);
  });

  it('rejects a malformed address rather than registering it', async () => {
    const { service, users } = svc();
    await expect(service.upsertUser('not-an-email')).rejects.toBeInstanceOf(NotFoundError);
    expect(users.size).toBe(0);
  });
});

describe('UserService.getProfileByEmail', () => {
  it('reports the current sign-in address, never the anchor', async () => {
    // After a change the two differ, and the anchor can be an opaque
    // `anchor-<hex>@users.invalid`. Reporting it would be both a leak and a lie.
    const { service, users } = svc([{ email: 'alice@corp.com', id: 'usr_a' }]);
    const row = users.get('alice@corp.com');
    if (row) row.current_email = 'alice@newcorp.com';
    expect(await service.getProfileByEmail('  ALICE@NEWCORP.COM  ')).toEqual({ email: 'alice@newcorp.com', id: 'usr_a' });
  });

  it('throws NotFound for an unknown email', async () => {
    const { service } = svc();
    await expect(service.getProfileByEmail('nobody@example.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not resolve a revoked address', async () => {
    // The account moved off this address. It must stop authenticating, or a
    // reassigned company address inherits the previous holder's backends.
    const { service, emails } = svc([{ email: 'alice@corp.com', id: 'usr_a' }]);
    const row = emails.get('alice@corp.com');
    if (row) row.is_verified = 0;
    await expect(service.getProfileByEmail('alice@corp.com')).rejects.toBeInstanceOf(NotFoundError);
  });
});
