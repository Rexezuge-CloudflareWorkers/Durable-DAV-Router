import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { RouterEnv } from '@/requestContext';

type UserApp = Hono<RouterEnv>;

function registerUserProfileRoutes(app: UserApp): void {
  app.get('/user/me', async (c) => {
    const account = c.get('AuthenticatedAccount');
    const scope = BaseRoute.getScope(c);
    // `email` is the account's *current* sign-in address, never the frozen
    // anchor — the SPA renders this in the header and on the settings page, and
    // an anchor can be an opaque `anchor-<hex>@users.invalid`. The route already
    // had the account from auth, so this is a confirmation that the address on
    // file is the one Access asserted, and a failure falls back to that rather
    // than 500ing the dashboard.
    const profile = await scope
      .get(Tokens.UserService)
      .getProfileByEmail(account.email)
      .catch(() => null);
    return c.json({ email: profile?.email ?? account.email, id: account.id });
  });
}

export { registerUserProfileRoutes };
