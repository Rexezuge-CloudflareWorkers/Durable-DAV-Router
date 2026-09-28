import type { D1Queryable } from '@durable-dav-router/backend-data/utils';
import { NotFoundError } from '@durable-dav-router/backend-errors';
import { isValidEmailFormat } from '@durable-dav-router/shared/utils';
import { UserIdentityService } from '../identity/UserIdentityService';
import type { AccountIdentity } from '../identity/UserIdentityService';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface UserServiceDeps {
  userIdentity?: () => Promise<UserIdentityService>;
}

/**
 * The `/user/me` plane: which account an authenticated address belongs to.
 *
 * Thin on purpose. Address → account resolution, registration, and the
 * revoke-on-change path all live in `UserIdentityService`; this is the entry
 * point the auth middleware and the user routes reach for, so a future identity
 * rule has one place to change.
 */
class UserService {
  private readonly deps: Required<UserServiceDeps>;

  constructor(
    private readonly env: UserServiceEnv,
    deps: UserServiceDeps = {},
  ) {
    this.deps = {
      userIdentity: () => Promise.resolve(new UserIdentityService(env)),
      ...deps,
    };
  }

  /**
   * Resolve the authenticated address to an account, registering one if the
   * address is unknown.
   *
   * Returns the account rather than nothing, because the caller needs its `id`:
   * `router_backends` is keyed on it, and it is the only value that survives an
   * address change. Resolution goes through the address registry rather than
   * `users.email`, so a person who changed their address keeps the same account
   * — and therefore the same backends — instead of acquiring a second, empty one.
   */
  public async upsertUser(email: string): Promise<AccountIdentity> {
    // Same normalization as `getProfileByEmail`; the two must agree or a user can
    // be written under one key and looked up under another.
    const normalized = email.trim().toLowerCase();
    if (!isValidEmailFormat(normalized)) throw new NotFoundError('User not found');
    const identity = await this.deps.userIdentity();
    return identity.resolveOrRegister(normalized);
  }

  /**
   * Profile for an address. Accepts either the current sign-in address or the
   * frozen anchor, and always reports the *current* address so a caller never
   * sees the internal anchor.
   */
  public async getProfileByEmail(email: string): Promise<{ email: string; id: string | null }> {
    // Trim as well as lowercase. Every identity source (Access JWT, `ctx.access`,
    // a bypass var) can carry incidental whitespace, and an untrimmed value
    // misses the `users` row and the owner-scoped backend lookup alike.
    const normalized = email.trim().toLowerCase();
    const identity = await this.deps.userIdentity();
    const account = await identity.resolveAccount(normalized);
    if (!account) throw new NotFoundError('User not found');
    return { email: account.email, id: account.id };
  }
}

export { UserService };
export type { UserServiceDeps, UserServiceEnv };
