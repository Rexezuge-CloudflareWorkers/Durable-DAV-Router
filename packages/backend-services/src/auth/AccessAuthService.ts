import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import { UnauthorizedError } from '@rexezuge/errors';
import { DEMO_USER_EMAIL } from '@durable-dav-router/shared/constants';
import { authenticateAccess, verifyAccessJwt as sdkVerifyAccessJwt } from '@rexezuge/http';
import type { AccessBinding, AccessJwtVerifier } from '@rexezuge/http';

interface AccessAuthEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  ENVIRONMENT?: string;
}

interface AccessIdentityContext {
  access?: {
    getIdentity: () => Promise<{ email?: string | null; emailVerified?: boolean | null; email_verified?: boolean | null } | null>;
  };
}

function toBinding(accessCtx?: AccessIdentityContext): AccessBinding | undefined {
  if (typeof accessCtx?.access?.getIdentity !== 'function') return undefined;
  const access = accessCtx.access;
  return {
    getIdentity: () => access.getIdentity().then((identity) => identity ?? undefined),
  };
}

function toOptions(env: AccessAuthEnv): Parameters<typeof authenticateAccess>[2] {
  const config = AppConfiguration.fromEnv(env);
  return {
    bypassAllowed: config.isBypassAllowed(),
    isDemoMode: config.isDemoMode(),
    demoUserEmail: DEMO_USER_EMAIL,
    devAuthEmail: config.getDevAuthEmail(),
    teamDomain: config.getTeamDomain(),
    policyAud: config.getPolicyAud(),
  };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(issuer);
  if (cached) {
    jwksCache.delete(issuer);
    jwksCache.set(issuer, cached);
    return cached;
  }
  const created = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  if (jwksCache.size >= 10) {
    const oldest = jwksCache.keys().next().value;
    if (oldest !== undefined) jwksCache.delete(oldest);
  }
  jwksCache.set(issuer, created);
  return created;
}

const defaultVerifier: AccessJwtVerifier = {
  async verify(token: string, teamDomain: string, policyAud: string): Promise<string> {
    const { payload } = await jwtVerify(token, jwksFor(teamDomain), { issuer: teamDomain, audience: policyAud });
    return typeof payload.email === 'string' ? payload.email : '';
  },
};

class AccessAuthService {
  constructor(private readonly env: AccessAuthEnv) {}

  public async getAuthenticatedUserEmail(request: Request, accessCtx?: AccessIdentityContext): Promise<string> {
    try {
      return await authenticateAccess(request, toBinding(accessCtx), toOptions(this.env));
    } catch (error) {
      if (error instanceof Error && error.name === 'AccessAuthError') {
        throw new UnauthorizedError(error.message);
      }
      throw error;
    }
  }

  public static async verifyAccessJwt(request: Request, teamDomain?: string, policyAud?: string): Promise<string> {
    if (!teamDomain || !policyAud) {
      throw new UnauthorizedError('Missing required JWT verification configuration.');
    }
    try {
      return await sdkVerifyAccessJwt(request, teamDomain, policyAud, defaultVerifier);
    } catch (error) {
      if (error instanceof Error && error.name === 'AccessAuthError') {
        throw new UnauthorizedError(error.message);
      }
      throw new UnauthorizedError('Cloudflare Access authentication failed.');
    }
  }
}

export { AccessAuthService };
export type { AccessAuthEnv, AccessIdentityContext };
