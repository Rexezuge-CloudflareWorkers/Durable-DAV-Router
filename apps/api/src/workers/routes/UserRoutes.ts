import type { Hono } from 'hono';
import { Tokens } from '@durable-dav-router/backend-services/composition';
import { BaseRoute } from '@/endpoints/IBaseRoute';

type UserApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerUserProfileRoutes(app: UserApp): void {
  app.get('/user/me', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const scope = BaseRoute.getScope(c);
    const profile = await scope
      .get(Tokens.UserService)
      .getProfileByEmail(email)
      .catch(() => null);
    return c.json({ email: profile?.email ?? email });
  });
}

export { registerUserProfileRoutes };
