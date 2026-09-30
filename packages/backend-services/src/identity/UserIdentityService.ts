import { UserDAO, UserEmailDAO } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';
import { BadRequestError, ConflictError, DatabaseError, NotFoundError } from '@durable-dav-router/backend-errors';
import { TimestampUtil, isValidEmailFormat } from '@durable-dav-router/shared/utils';

interface UserIdentityEnv {
  DB: D1Queryable;
}

interface UserIdentityDeps {
  userDAO?: () => Promise<UserDAO>;
  userEmailDAO?: () => Promise<UserEmailDAO>;
}

/**
 * A resolved account.
 *
 * `id` is the only value that should be used as an identity. `email` is the
 * address the account currently signs in with, and `anchorEmail` is the
 * immutable internal value that `router_backends.owner_email` stores and that
 * its foreign key resolves against — never report it.
 */
interface AccountIdentity {
  id: string;
  email: string;
  anchorEmail: string;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A `users` row is only an account once it has an `id`, i.e. once migration
 * 0004 has run. Without one there is nothing to key a backend registration on,
 * and inventing a value would split the account in two.
 */
interface MaybeUserRow {
  id?: string | null;
  email: string;
  current_email?: string | null;
}

function accountOf(row: MaybeUserRow | null): AccountIdentity | null {
  return row?.id ? { id: row.id, email: normalize(row.current_email ?? row.email), anchorEmail: row.email } : null;
}

/**
 * The account behind an address.
 *
 * Resolution is address → `user_emails` → `users.id`, so an account keeps
 * working after it changes its address: the new address resolves through the
 * registry to the same id that every registered backend points at.
 *
 * Results are memoized for the lifetime of the instance, which is one request
 * scope — the auth middleware resolves the caller and several routes then read
 * their backends off that same account.
 */
class UserIdentityService {
  private readonly deps: Required<UserIdentityDeps>;
  private readonly byEmail = new Map<string, AccountIdentity | null>();

  constructor(
    private readonly env: UserIdentityEnv,
    deps: UserIdentityDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      userEmailDAO: () => Promise.resolve(new UserEmailDAO(env.DB)),
      ...deps,
    };
  }

  /**
   * Resolve a sign-in address to its account, or null when unknown.
   *
   * Only a verified address resolves. A revoked address (changed away from) is
   * retained for attribution but must never authenticate, otherwise a reassigned
   * company address would inherit the previous holder's backends.
   */
  public async resolveAccount(email: string): Promise<AccountIdentity | null> {
    const key = normalize(email);
    if (!isValidEmailFormat(key)) return null;
    if (this.byEmail.has(key)) return this.byEmail.get(key) ?? null;
    const resolved = await this.load(key);
    this.byEmail.set(key, resolved);
    return resolved;
  }

  /**
   * Account behind an id. The inverse direction, for callers that already hold a
   * stable key and need the current address.
   */
  public async resolveUserById(userId: string): Promise<AccountIdentity | null> {
    try {
      const dao = await this.deps.userDAO();
      return accountOf(await dao.getById(userId));
    } catch (error) {
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(`resolve account by id: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async load(email: string): Promise<AccountIdentity | null> {
    const emailDAO = await this.deps.userEmailDAO();
    const userDAO = await this.deps.userDAO();
    // A known address is authoritative, and a *revoked* one must not resolve:
    // falling through to a `users` lookup would let a reassigned address keep
    // authenticating the previous holder's account.
    const registered = await emailDAO.get(email);
    if (registered) {
      return registered.is_verified === 1 ? accountOf(await userDAO.getById(registered.user_id)) : null;
    }
    // No registry row. Migration 0004 backfilled a verified row for every anchor,
    // so a row-less address is either brand new or on a database that has not
    // run 0004, where the address *is* the anchor. Both are covered by the
    // `users` lookups. A revoked address always has a row and returned above.
    return accountOf((await userDAO.getByCurrentEmail(email)) ?? (await userDAO.getByEmail(email)));
  }

  /**
   * Every address known for an account, verified ones first.
   */
  public async listAddresses(userId: string): Promise<Array<{ email: string; isVerified: boolean }>> {
    const dao = await this.deps.userEmailDAO();
    const rows = await dao.listByUserId(userId);
    return rows.map((row) => ({ email: row.email, isVerified: row.is_verified === 1 }));
  }

  /**
   * Resolve an authenticated address to an existing account, registering one if
   * the address is unknown.
   *
   * This is the fork guard. Registration used to be keyed on the address alone,
   * so a person who changed their address would acquire a *second*, empty
   * account and silently orphan the backends registered under the first.
   * Resolving through the registry first means an address always lands on the
   * account it already belongs to.
   */
  public async resolveOrRegister(email: string): Promise<AccountIdentity> {
    const loginEmail = normalize(email);
    if (!isValidEmailFormat(loginEmail)) throw new BadRequestError('Invalid email address');
    const existing = await this.resolveAccount(loginEmail);
    if (existing) return existing;
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const userDAO = await this.deps.userDAO();
    const emailDAO = await this.deps.userEmailDAO();
    const id = UserDAO.newId();
    // Anchor on the address when it is free, which keeps new rows shaped like the
    // pre-0004 ones. The insert is a no-op when the anchor is already held.
    await userDAO.createUser({ id, anchor: loginEmail, loginEmail, now });
    const anchored = await userDAO.getById(id);
    if (anchored?.id !== id) {
      // The address is another account's *anchor*: its previous holder moved off
      // it, but the address is still reserved as a primary key. Anchor opaquely
      // instead, so the address is released for whoever legitimately holds it now.
      await userDAO.createUser({ id, anchor: UserDAO.newAnchor(), loginEmail, now });
      const retried = await userDAO.getById(id);
      if (retried?.id !== id) throw new DatabaseError('Failed to register account');
    }
    // Claim the sign-in address *before* resolving, otherwise the fresh account
    // is invisible to the registry and registration reads as a failure. An
    // address already verified for another account is left alone by `register`,
    // and the resolve below then reports *that* account — the right outcome, not
    // a failure: the caller still authenticates as the account the address
    // belongs to, and a second one is never forked.
    await emailDAO.register({ email: loginEmail, userId: id, isVerified: true, now });
    // `resolveAccount` memoized the miss above; that entry is exactly what
    // registration just invalidated.
    this.byEmail.delete(loginEmail);
    const registered = await this.resolveAccount(loginEmail);
    if (!registered) throw new DatabaseError('Failed to register account');
    return registered;
  }

  /**
   * Point an account at a new sign-in address.
   *
   * The account id, the frozen anchor, and every id-keyed backend registration
   * are untouched: only which address authenticates the account moves. The
   * previous address is revoked rather than deleted, so rows written before the
   * change still resolve to this account, and the address is released for a later
   * legitimate holder.
   *
   * Rejects an address that is already verified for another account. That check
   * is the whole reason this is not simply an `UPDATE`: Cloudflare Access is the
   * only authenticator, so an unverified self-service change would let anyone
   * claim an address and inherit its backends.
   *
   * **No route exposes this.** Proof of control for the new address (a confirm
   * step performed while authenticated as that address) has to land first. Until
   * then this is the ops path — see `scripts/change-email.ts`, which performs the
   * same three statements in the same order.
   */
  public async setPrimaryEmail(
    userId: string,
    newEmail: string,
    now = TimestampUtil.getCurrentUnixTimestampInSeconds(),
  ): Promise<AccountIdentity> {
    const email = normalize(newEmail);
    if (!isValidEmailFormat(email)) throw new BadRequestError('Invalid email address');
    const userDAO = await this.deps.userDAO();
    const emailDAO = await this.deps.userEmailDAO();
    const current = accountOf(await userDAO.getById(userId));
    if (!current) throw new NotFoundError('User not found');
    if (current.email === email) return current;
    const holder = await emailDAO.resolveVerified(email);
    if (holder && holder.user_id !== current.id) throw new ConflictError('Email is already in use');
    // Claim first, move second, revoke last. That order is what keeps the
    // account reachable throughout: revoking first opens a window where neither
    // address authenticates.
    await emailDAO.register({ email, userId: current.id, isVerified: true, now });
    await userDAO.setCurrentEmail(current.id, email, now);
    await emailDAO.revokeAllVerified(current.id, email);
    this.byEmail.delete(current.email);
    this.byEmail.set(email, { ...current, email });
    return { ...current, email };
  }

  /**
   * Ops path: attach an address that has already been proven, without making it
   * the sign-in address.
   */
  public async linkVerifiedEmail(userId: string, email: string, now = TimestampUtil.getCurrentUnixTimestampInSeconds()): Promise<void> {
    const address = normalize(email);
    if (!isValidEmailFormat(address)) throw new BadRequestError('Invalid email address');
    const dao = await this.deps.userEmailDAO();
    const outcome = await dao.register({ email: address, userId, isVerified: true, now });
    if (outcome === 'already-claimed') throw new ConflictError('Email is already in use');
  }
}

export { UserIdentityService };
export type { AccountIdentity, UserIdentityDeps, UserIdentityEnv };
