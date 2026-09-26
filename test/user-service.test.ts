import { describe, expect, it, vi } from 'vitest';
import { UserService } from '@durable-dav-router/backend-services/user';
import { NotFoundError } from '@durable-dav-router/backend-errors';
import type { UserDAO } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';

function fakeDao(seed: Array<{ email: string }> = []) {
  // Annotated: without it the Map's value type is inferred from `seed` alone,
  // so the `created_at` the upsert stores is a type error on the next line.
  const rows = new Map<string, { email: string; created_at?: number }>(seed.map((r) => [r.email, r]));
  return {
    calls: [] as string[],
    upsertUser: vi.fn(async (email: string, _now: number) => {
      if (!rows.has(email)) rows.set(email, { email, created_at: 1 });
    }),
    getByEmail: vi.fn(async (email: string) => rows.get(email) ?? null),
    _rows: rows,
  };
}

const svc = (dao: ReturnType<typeof fakeDao>) =>
  new UserService({ DB: {} as D1Queryable }, { userDAO: () => Promise.resolve(dao as unknown as UserDAO) });

describe('UserService.upsertUser', () => {
  it('stores the email lowercased', async () => {
    // `router_backends.owner_email` is a foreign key into `users.email`, and
    // the DAO predicates compare a lowercased parameter, so the stored value
    // has to be lowercase for either to work.
    const dao = fakeDao();
    await svc(dao).upsertUser('User@Example.com');
    expect(dao.upsertUser).toHaveBeenCalledWith('user@example.com', expect.any(Number));
  });

  it('is idempotent', async () => {
    const dao = fakeDao();
    const service = svc(dao);
    await service.upsertUser('user@example.com');
    await service.upsertUser('user@example.com');
    // Both calls go to the DAO; the conflict is resolved by ON CONFLICT DO
    // NOTHING there, so the service must not add its own existence check.
    expect(dao.upsertUser).toHaveBeenCalledTimes(2);
    expect(dao._rows.size).toBe(1);
  });
});

describe('UserService.getProfileByEmail', () => {
  it('returns the stored email', async () => {
    const dao = fakeDao([{ email: 'user@example.com' }]);
    expect(await svc(dao).getProfileByEmail('User@Example.com')).toEqual({ email: 'user@example.com' });
  });

  it('looks up with a lowercased email', async () => {
    const dao = fakeDao([{ email: 'user@example.com' }]);
    await svc(dao).getProfileByEmail('  USER@EXAMPLE.COM  ');
    expect(dao.getByEmail).toHaveBeenCalledWith('user@example.com');
  });

  it('throws NotFound for an unknown email', async () => {
    const dao = fakeDao();
    await expect(svc(dao).getProfileByEmail('nobody@example.com')).rejects.toBeInstanceOf(NotFoundError);
  });
});
