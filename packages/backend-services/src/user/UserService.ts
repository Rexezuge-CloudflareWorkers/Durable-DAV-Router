import { UserDAO } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';
import { NotFoundError } from '@durable-dav-router/backend-errors';
import { TimestampUtil } from '@durable-dav-router/shared/utils';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface UserServiceDeps {
  userDAO?: () => Promise<UserDAO>;
}

class UserService {
  private readonly deps: Required<UserServiceDeps>;

  constructor(
    private readonly env: UserServiceEnv,
    deps: UserServiceDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      ...deps,
    };
  }

  public async upsertUser(email: string): Promise<void> {
    const normalized = email.toLowerCase();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const dao = await this.deps.userDAO();
    await dao.upsertUser(normalized, now);
  }

  public async getProfileByEmail(email: string): Promise<{ email: string }> {
    const dao = await this.deps.userDAO();
    const row = await dao.getByEmail(email.toLowerCase());
    if (!row) throw new NotFoundError('User not found');
    return { email: row.email };
  }
}

export { UserService };
export type { UserServiceDeps, UserServiceEnv };
