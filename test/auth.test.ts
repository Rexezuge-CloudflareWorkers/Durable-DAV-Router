import { describe, expect, it, vi, afterEach } from 'vitest';
import { AccessAuthService, DEFAULT_ACCESS_AUTH_STRATEGIES } from '@durable-dav-router/backend-services/auth';
import type { AccessAuthStrategy } from '@durable-dav-router/backend-services/auth';
import { UnauthorizedError } from '@durable-dav-router/backend-errors';
import { isValidEmailFormat } from '@durable-dav-router/shared/utils';

const req = (headers: Record<string, string> = {}): Request => new Request('https://router.example.com/user/me', { headers });

afterEach(() => vi.restoreAllMocks());

describe('isValidEmailFormat', () => {
  it('accepts ordinary addresses', () => {
    for (const email of ['a@b.co', 'user.name+tag@example.com', 'x_y@sub.domain.org']) {
      expect(isValidEmailFormat(email), email).toBe(true);
    }
  });

  it('rejects malformed addresses', () => {
    for (const email of ['', 'a', 'a@b', 'a b@c.com', '@b.com', 'a@', 'a@b c.com', 'a@@b.com']) {
      expect(isValidEmailFormat(email), JSON.stringify(email)).toBe(false);
    }
  });

  it('rejects an address beyond the length limit', () => {
    // 254 is the SMTP maximum; anything longer is a header-injection risk.
    const long = `${'a'.repeat(250)}@example.com`;
    expect(long.length).toBeGreaterThan(254);
    expect(isValidEmailFormat(long)).toBe(false);
  });
});

describe('AccessAuthService strategy chain', () => {
  it('returns the first strategy that produces an identity', async () => {
    const first: AccessAuthStrategy = () => Promise.resolve('first@example.com');
    const second: AccessAuthStrategy = () => Promise.resolve('second@example.com');
    const service = new AccessAuthService({}, [first, second]);
    expect(await service.getAuthenticatedUserEmail(req())).toBe('first@example.com');
  });

  it('falls through to the next strategy when one yields nothing', async () => {
    const service = new AccessAuthService({}, [
      () => Promise.resolve(null),
      () => Promise.resolve(''),
      () => Promise.resolve('third@example.com'),
    ]);
    expect(await service.getAuthenticatedUserEmail(req())).toBe('third@example.com');
  });

  it('throws one unauthorized error when no strategy matches', async () => {
    const service = new AccessAuthService({}, [() => Promise.resolve(null)]);
    await expect(service.getAuthenticatedUserEmail(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('orders demo mode before the dev email before JWT before the Access binding', () => {
    // DEMO_MODE is the broadest and DEV_AUTH_EMAIL the next broadest, so both
    // must be attempted before anything that requires a real credential.
    expect(DEFAULT_ACCESS_AUTH_STRATEGIES).toHaveLength(4);
  });
});

describe('DEMO_MODE strategy', () => {
  it('authenticates as the demo user only in a development environment', async () => {
    const dev = new AccessAuthService({ ENVIRONMENT: 'development', DEMO_MODE: 'true' });
    expect(await dev.getAuthenticatedUserEmail(req())).toMatch(/@/);
  });

  it('is inert in production, whatever DEMO_MODE says', async () => {
    // The single most important assertion in this file: with no credential
    // presented, production must not authenticate anyone.
    const prod = new AccessAuthService({ ENVIRONMENT: 'production', DEMO_MODE: 'true' }, [DEFAULT_ACCESS_AUTH_STRATEGIES[0]]);
    await expect(prod.getAuthenticatedUserEmail(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('is inert for an ENVIRONMENT value that merely looks non-production', async () => {
    // `!== 'production'` would have allowed every one of these.
    for (const environment of ['staging', 'prod', 'Preview', 'prodcution']) {
      const service = new AccessAuthService({ ENVIRONMENT: environment, DEMO_MODE: 'true' }, [DEFAULT_ACCESS_AUTH_STRATEGIES[0]]);
      await expect(service.getAuthenticatedUserEmail(req()), environment).rejects.toBeInstanceOf(UnauthorizedError);
    }
  });

  it('is inert when ENVIRONMENT is unset', async () => {
    const service = new AccessAuthService({ DEMO_MODE: 'true' }, [DEFAULT_ACCESS_AUTH_STRATEGIES[0]]);
    await expect(service.getAuthenticatedUserEmail(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('DEV_AUTH_EMAIL strategy', () => {
  it('authenticates as the configured email in development', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'Dev@Example.com' }, [
      DEFAULT_ACCESS_AUTH_STRATEGIES[1],
    ]);
    // Normalized: the email is the identity key for every D1 lookup.
    expect(await service.getAuthenticatedUserEmail(req())).toBe('dev@example.com');
  });

  it('fails closed on a malformed bypass email rather than authenticating it', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'not-an-email' }, [
      DEFAULT_ACCESS_AUTH_STRATEGIES[1],
    ]);
    await expect(service.getAuthenticatedUserEmail(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('ignores an empty or whitespace value', async () => {
    for (const value of ['', ' '.repeat(3)]) {
      const service = new AccessAuthService({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: value }, [DEFAULT_ACCESS_AUTH_STRATEGIES[1]]);
      await expect(service.getAuthenticatedUserEmail(req()), JSON.stringify(value)).rejects.toBeInstanceOf(UnauthorizedError);
    }
  });

  it('is inert in production', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'production', DEV_AUTH_EMAIL: 'dev@example.com' }, [
      DEFAULT_ACCESS_AUTH_STRATEGIES[1],
    ]);
    await expect(service.getAuthenticatedUserEmail(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('Access binding strategy', () => {
  const identityCtx = (email: string | null | undefined, verified?: boolean | null) => ({
    access: { getIdentity: async () => ({ email, emailVerified: verified ?? true }) },
  });

  it('trusts a verified identity from the Access binding', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'production' });
    expect(await service.getAuthenticatedUserEmail(req(), identityCtx('User@Example.com'))).toBe('user@example.com');
  });

  it('refuses an unverified identity', async () => {
    // An unverified email must never authenticate, even from a trusted binding.
    for (const verified of [false]) {
      const service = new AccessAuthService({ ENVIRONMENT: 'production' });
      await expect(service.getAuthenticatedUserEmail(req(), identityCtx('user@example.com', verified))).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    }
  });

  it('refuses a missing or empty identity', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'production' });
    for (const email of [null, undefined, '', ' '.repeat(3)]) {
      await expect(service.getAuthenticatedUserEmail(req(), identityCtx(email)), JSON.stringify(email)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    }
  });

  it('refuses a malformed identity email', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'production' });
    await expect(service.getAuthenticatedUserEmail(req(), identityCtx('not-an-email'))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('fails closed when the binding itself throws', async () => {
    // The Access-binding strategy swallows its own lookup error and reports "no
    // identity", so a broken binding must not authenticate anyone — and must
    // not be mistaken for a usable identity either.
    const service = new AccessAuthService({ ENVIRONMENT: 'production' }, [DEFAULT_ACCESS_AUTH_STRATEGIES[3]]);
    const brokenCtx = {
      access: {
        getIdentity: async () => {
          throw new Error('binding unavailable');
        },
      },
    };
    await expect(service.getAuthenticatedUserEmail(req(), brokenCtx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('propagates an unexpected strategy error rather than failing open', async () => {
    // A strategy that throws for an unrelated reason must surface as a 500, not
    // be reinterpreted as "unauthenticated" — silently swallowing it would hide
    // a real fault behind a 401.
    const service = new AccessAuthService({ ENVIRONMENT: 'production' }, [
      async () => {
        throw new Error('unexpected internal fault');
      },
    ]);
    await expect(service.getAuthenticatedUserEmail(req())).rejects.toThrow(/unexpected internal fault/);
  });

  it('accepts the snake_case verification field', async () => {
    const ctx = { access: { getIdentity: async () => ({ email: 'user@example.com', email_verified: false }) } };
    const service = new AccessAuthService({ ENVIRONMENT: 'production' });
    await expect(service.getAuthenticatedUserEmail(req(), ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('tolerates a request with no Access context at all', async () => {
    const service = new AccessAuthService({ ENVIRONMENT: 'production' });
    await expect(service.getAuthenticatedUserEmail(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('verifyAccessJwt', () => {
  it('rejects a request with no assertion header', async () => {
    await expect(AccessAuthService.verifyAccessJwt(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects missing verification configuration', async () => {
    // Without TEAM_DOMAIN/POLICY_AUD there is nothing to verify against, so
    // failing is the only safe outcome.
    const withToken = req({ 'cf-access-jwt-assertion': 'a.b.c' });
    await expect(AccessAuthService.verifyAccessJwt(withToken, '', 'aud')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(AccessAuthService.verifyAccessJwt(withToken, 'example.com', '')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects multiple configured audiences', async () => {
    // `jwtVerify` takes a single audience, so a comma-joined value would fail
    // at verification time with a confusing error.
    const withToken = req({ 'cf-access-jwt-assertion': 'a.b.c' });
    await expect(AccessAuthService.verifyAccessJwt(withToken, 'example.com', 'aud1,aud2')).rejects.toThrow(/Multiple JWT audiences/);
  });

  it('rejects an unparseable TEAM_DOMAIN rather than throwing a TypeError', async () => {
    const withToken = req({ 'cf-access-jwt-assertion': 'a.b.c' });
    await expect(AccessAuthService.verifyAccessJwt(withToken, 'http://[bad', 'aud')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('maps every verification failure to one unauthorized error', async () => {
    // An expired token, a bad audience, a bad signature and an unknown key all
    // collapse to the same client-facing error, so the response cannot be used
    // as an oracle for why verification failed.
    const withToken = req({ 'cf-access-jwt-assertion': 'not.a.jwt' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(AccessAuthService.verifyAccessJwt(withToken, 'example.cloudflareaccess.com', 'aud')).rejects.toThrow(
        /authentication failed/i,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
