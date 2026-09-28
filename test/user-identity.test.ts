import { describe, expect, it, vi } from 'vitest';
import { UserIdentityService } from '@durable-dav-router/backend-services/identity';
import type { AccountIdentity } from '@durable-dav-router/backend-services/identity';
import { BadRequestError, ConflictError, NotFoundError } from '@durable-dav-router/backend-errors';
import type { UserDAO, UserEmailDAO } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';

interface UserRecord {
  id: string;
  /**
  The frozen anchor — `users.email`. Never updated after creation.
  */
  email: string;
  current_email: string;
  created_at: number;
}

interface EmailRecord {
  email: string;
  user_id: string;
  is_verified: number;
  created_at: number;
}

/**
 * Two maps, so the anchor table and the registry cannot drift apart in the
 * double. String matching is exact and case-sensitive, as on D1: the DAOs
 * lowercase the *parameter* precisely so the comparison stays exact, and a
 * double that folded both sides would make a wrong predicate look right.
 */
function harness() {
  const users = new Map<string, UserRecord>();
  const emails = new Map<string, EmailRecord>();
  const userDAO = {
    createUser: vi.fn(async (input: { id?: string | null; anchor: string; loginEmail: string; now: number }) => {
      const anchor = input.anchor.toLowerCase();
      // `ON CONFLICT(email) DO NOTHING` — the anchor being taken is a no-op,
      // not an error, and that is what makes the opaque retry safe.
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
      // A verified row belongs to someone; never re-point it silently.
      if (existing?.is_verified === 1) return 'already-claimed' as const;
      emails.set(email, { email, user_id: input.userId, is_verified: input.isVerified ? 1 : 0, created_at: input.now });
      return 'claimed' as const;
    }),
    listByUserId: vi.fn(async (userId: string) => [...emails.values()].filter((e) => e.user_id === userId)),
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
  return { identity, users, emails, userDAO, userEmailDAO };
}

/**
A pre-0004 account: anchored on its real address, one verified registry row.
*/
function seedAccount(h: ReturnType<typeof harness>, email: string, id: string): UserRecord {
  const row: UserRecord = { id, email, current_email: email, created_at: 1 };
  h.users.set(email, row);
  h.emails.set(email, { email, user_id: id, is_verified: 1, created_at: 1 });
  return row;
}

describe('UserIdentityService.resolveAccount', () => {
  it('resolves a sign-in address to its account through the registry', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    expect(await h.identity.resolveAccount('Alice@Corp.com')).toEqual({
      id: 'usr_a',
      email: 'alice@corp.com',
      anchorEmail: 'alice@corp.com',
    });
  });

  it('returns null for an unknown address', async () => {
    expect(await harness().identity.resolveAccount('nobody@example.com')).toBeNull();
  });

  it('returns null for a malformed address without touching D1', async () => {
    const h = harness();
    expect(await h.identity.resolveAccount('not-an-email')).toBeNull();
    expect(h.userEmailDAO.get).not.toHaveBeenCalled();
  });

  it('does not resolve a revoked address, and does not fall through to the anchor', async () => {
    // The single most important assertion in this file. A revoked registry row is
    // authoritative: if resolution continued to `users`, a reassigned company
    // address would keep authenticating the previous holder's account — and
    // inheriting their registered backends.
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    h.emails.get('alice@corp.com')!.is_verified = 0;
    expect(await h.identity.resolveAccount('alice@corp.com')).toBeNull();
    // The fallback lookups must not have been reached at all.
    expect(h.userDAO.getByEmail).not.toHaveBeenCalled();
  });

  it('memoizes per instance, so one request resolves an address once', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await h.identity.resolveAccount('alice@corp.com');
    await h.identity.resolveAccount('alice@corp.com');
    expect(h.userEmailDAO.get).toHaveBeenCalledTimes(1);
  });

  it('resolves a new address back to the same account after a change', async () => {
    // The bug this change exists to close: before it, the address was the
    // account, so a new address meant a new, empty account.
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await h.identity.setPrimaryEmail('usr_a', 'alice@newcorp.com');
    const resolved = await h.identity.resolveAccount('alice@newcorp.com');
    expect(resolved?.id).toBe('usr_a');
  });

  it('falls back to a users lookup for a database with no registry row', async () => {
    // Pre-0004 floor, and also a brand-new address on a migrated database: the
    // anchor table is authoritative when it has an opinion, and the `users`
    // lookups are the floor when it does not.
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    h.emails.delete('alice@corp.com');
    const resolved = await h.identity.resolveAccount('alice@corp.com');
    expect(resolved?.id).toBe('usr_a');
  });

  it('prefers the current-email lookup over the anchor lookup', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    h.emails.delete('alice@corp.com');
    h.users.get('alice@corp.com')!.current_email = 'alice@newcorp.com';
    const resolved = await h.identity.resolveAccount('alice@newcorp.com');
    expect(resolved?.id).toBe('usr_a');
  });
});

describe('UserIdentityService.resolveUserById', () => {
  it('inverts the direction: id to current address', async () => {
    const h = harness();
    const row = seedAccount(h, 'alice@corp.com', 'usr_a');
    row.current_email = 'alice@newcorp.com';
    const byId = await h.identity.resolveUserById('usr_a');
    expect(byId).toEqual({
      id: 'usr_a',
      email: 'alice@newcorp.com',
      anchorEmail: 'alice@corp.com',
    });
  });

  it('returns null for an unknown id', async () => {
    expect(await harness().identity.resolveUserById('usr_missing')).toBeNull();
  });
});

describe('UserIdentityService.resolveOrRegister', () => {
  it('anchors a new account on its own address, keeping the pre-0004 shape', async () => {
    const h = harness();
    const account = await h.identity.resolveOrRegister('Bob@Example.com');
    expect(account.anchorEmail).toBe('bob@example.com');
    expect(h.users.has('bob@example.com')).toBe(true);
  });

  it('does nothing when the address already identifies an account', async () => {
    const h = harness();
    seedAccount(h, 'bob@example.com', 'usr_b');
    const existing = await h.identity.resolveOrRegister('bob@example.com');
    expect(existing.id).toBe('usr_b');
    expect(h.userDAO.createUser).not.toHaveBeenCalled();
  });

  it('anchors opaquely when the address is already another account’s anchor', async () => {
    // Alice moved off `alice@corp.com`, so her anchor still holds it as a
    // primary key. The new holder must still get a working account, and the
    // address must not become permanently unusable.
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    h.emails.get('alice@corp.com')!.is_verified = 0;
    const account = await h.identity.resolveOrRegister('alice@corp.com');
    expect(account.id).not.toBe('usr_a');
    expect(account.anchorEmail).toMatch(/^anchor-[0-9a-f]{32}@users\.invalid$/);
    // Alice's anchor row is untouched — the cascade still resolves to her.
    expect(h.users.get('alice@corp.com')?.id).toBe('usr_a');
  });

  it('rejects a malformed address', async () => {
    await expect(harness().identity.resolveOrRegister('nope')).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('UserIdentityService.setPrimaryEmail', () => {
  it('moves the sign-in address and leaves the anchor alone', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    const account = await h.identity.setPrimaryEmail('usr_a', 'Alice@NewCorp.com');
    expect(account).toEqual({ id: 'usr_a', email: 'alice@newcorp.com', anchorEmail: 'alice@corp.com' });
    expect(h.users.get('alice@corp.com')?.current_email).toBe('alice@newcorp.com');
    // The anchor is frozen: `router_backends.owner_email` cascades from it, so
    // updating it would fail the FK or delete the user's backends.
    expect(h.users.get('alice@corp.com')?.email).toBe('alice@corp.com');
  });

  it('revokes the previous address but keeps it for attribution', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await h.identity.setPrimaryEmail('usr_a', 'alice@newcorp.com');
    expect(h.emails.get('alice@corp.com')?.is_verified).toBe(0);
    expect(h.emails.get('alice@newcorp.com')?.is_verified).toBe(1);
    // The row survives, so a backend registered under the old address stays
    // attributable to this account.
    expect(h.emails.get('alice@corp.com')?.user_id).toBe('usr_a');
  });

  it('is a no-op when the address is already current', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    const before = h.users.get('alice@corp.com')!;
    const account = await h.identity.setPrimaryEmail('usr_a', 'alice@corp.com');
    expect(account.email).toBe('alice@corp.com');
    expect(h.userDAO.setCurrentEmail).not.toHaveBeenCalled();
    expect(h.users.get('alice@corp.com')).toBe(before);
  });

  it('refuses an address that is a live login for another account', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    seedAccount(h, 'bob@corp.com', 'usr_b');
    await expect(h.identity.setPrimaryEmail('usr_a', 'bob@corp.com')).rejects.toBeInstanceOf(ConflictError);
    // Nothing was half-applied.
    expect(h.users.get('alice@corp.com')?.current_email).toBe('alice@corp.com');
  });

  it('accepts an address this account previously held and revoked', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await h.identity.setPrimaryEmail('usr_a', 'alice@newcorp.com');
    const back = await h.identity.setPrimaryEmail('usr_a', 'alice@corp.com');
    expect(back.email).toBe('alice@corp.com');
    expect(h.emails.get('alice@corp.com')?.is_verified).toBe(1);
  });

  it('rejects an unknown account and a malformed address', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await expect(h.identity.setPrimaryEmail('usr_missing', 'x@y.com')).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.identity.setPrimaryEmail('usr_a', 'nope')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('re-points its own memo so the new address resolves within the same scope', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await h.identity.setPrimaryEmail('usr_a', 'alice@newcorp.com');
    const resolved = await h.identity.resolveAccount('alice@newcorp.com');
    expect(resolved?.id).toBe('usr_a');
  });
});

describe('UserIdentityService.listAddresses', () => {
  it('lists every known address with its login state', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await h.identity.setPrimaryEmail('usr_a', 'alice@newcorp.com');
    const listed = await h.identity.listAddresses('usr_a');
    expect(listed).toEqual(
      expect.arrayContaining([
        { email: 'alice@newcorp.com', isVerified: true },
        { email: 'alice@corp.com', isVerified: false },
      ]),
    );
  });
});

describe('UserIdentityService.linkVerifiedEmail', () => {
  it('attaches a proven address without making it the sign-in address', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    await h.identity.linkVerifiedEmail('usr_a', 'alias@corp.com');
    expect(h.emails.get('alias@corp.com')?.user_id).toBe('usr_a');
    expect(h.users.get('alice@corp.com')?.current_email).toBe('alice@corp.com');
  });

  it('refuses an address already claimed by another account', async () => {
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    seedAccount(h, 'bob@corp.com', 'usr_b');
    await expect(h.identity.linkVerifiedEmail('usr_a', 'bob@corp.com')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('account shape', () => {
  it('carries the id, the current address, and the frozen anchor separately', async () => {
    // The three fields exist so no call site has to guess which email is which.
    // A type that collapsed them would make the anchor silently reportable.
    const h = harness();
    seedAccount(h, 'alice@corp.com', 'usr_a');
    const account: AccountIdentity = (await h.identity.resolveAccount('alice@corp.com'))!;
    expect(Object.keys(account).sort()).toEqual(['anchorEmail', 'email', 'id']);
  });
});
