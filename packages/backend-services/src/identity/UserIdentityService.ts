import { BadRequestError } from '@rexezuge/errors';
import { UserIdentityService as SdkUserIdentityService } from '@rexezuge/identity';
import type { ResolvedAccount,   } from '@rexezuge/identity';
import { isValidEmailFormat } from '@rexezuge/shared';

type AccountIdentity = ResolvedAccount;

/**
 * Router account resolution: the SDK service plus a fail-closed registration
 * guard.
 *
 * `resolveOrRegister` is reachable from `UserService.upsertUser` (which
 * validates first) but also directly, and an unvalidated address would be
 * stored as a `users` anchor and a verified registry row — an account whose
 * address can never have authenticated anything. Reject it here rather than
 * persisting it.
 */
class UserIdentityService extends SdkUserIdentityService {
  public override async resolveOrRegister(email: string, now?: number): Promise<ResolvedAccount | null> {
    const loginEmail = email.trim().toLowerCase();
    if (!isValidEmailFormat(loginEmail)) throw new BadRequestError('Invalid email address');
    return super.resolveOrRegister(email, now);
  }
}

export { UserIdentityService };
export type { AccountIdentity,   };

export {type UserIdentityDeps, type UserIdentityEnv} from '@rexezuge/identity';