import { describe, expect, it } from 'vitest';
import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import { AuthConfig } from '@durable-dav-router/backend-runtime/config';
import { RouterLimits } from '@durable-dav-router/backend-runtime/config';
import { EnvParser } from '@durable-dav-router/backend-runtime/config';

const config = (env: Record<string, unknown>) => AppConfiguration.fromEnv(env);

describe('EnvParser', () => {
  it('falls back to the default when unset or unparsable', () => {
    expect(EnvParser.positiveInt({}, 'N', '5')).toBe(5);
    expect(EnvParser.positiveInt({ N: 'banana' }, 'N', '5')).toBe(5);
    expect(EnvParser.positiveInt({ N: '0' }, 'N', '5')).toBe(5);
    expect(EnvParser.positiveInt({ N: '-3' }, 'N', '5')).toBe(5);
    expect(EnvParser.positiveInt({ N: '2.5' }, 'N', '5')).toBe(5);
  });

  it('accepts a valid positive integer', () => {
    expect(EnvParser.positiveInt({ N: '42' }, 'N', '5')).toBe(42);
  });

  it('reports validity without throwing, so validate() can collect every problem', () => {
    expect(EnvParser.isValidPositiveInt({}, 'N')).toBe(true);
    expect(EnvParser.isValidPositiveInt({ N: '7' }, 'N')).toBe(true);
    expect(EnvParser.isValidPositiveInt({ N: 'nope' }, 'N')).toBe(false);
  });

  it('treats only the exact string "true" as a boolean', () => {
    expect(EnvParser.boolean({ B: 'true' }, 'B', 'false')).toBe(true);
    expect(EnvParser.boolean({ B: 'TRUE' }, 'B', 'false')).toBe(false);
    expect(EnvParser.boolean({ B: '1' }, 'B', 'false')).toBe(false);
    expect(EnvParser.boolean({}, 'B', 'true')).toBe(true);
  });
});

describe('RouterLimits', () => {
  it('reads each limit with a safe default', () => {
    const limits = new RouterLimits({});
    expect(limits.getMaxBackendsPerUser()).toBe(20);
    expect(limits.getBackendFetchTimeoutMs()).toBe(8000);
    expect(limits.getRouteCacheTtlSeconds()).toBe(86_400);
  });

  it('honours explicit values', () => {
    const limits = new RouterLimits({ MAX_BACKENDS_PER_USER: '5', BACKEND_FETCH_TIMEOUT_MS: '1500', ROUTE_CACHE_TTL_SECONDS: '60' });
    expect(limits.getMaxBackendsPerUser()).toBe(5);
    expect(limits.getBackendFetchTimeoutMs()).toBe(1500);
    expect(limits.getRouteCacheTtlSeconds()).toBe(60);
  });

  it('falls back rather than propagating a malformed value', () => {
    // A typo silently becoming the default is why `validate()` exists; the
    // getter must not throw, or a request would 500 on bad config.
    const limits = new RouterLimits({ MAX_BACKENDS_PER_USER: 'lots' });
    expect(limits.getMaxBackendsPerUser()).toBe(20);
  });
});

describe('AuthConfig environment gating', () => {
  // `isBypassAllowed` is the single switch that decides whether an
  // unauthenticated request may authenticate as a fixed identity. It must be an
  // allow-list: a deny-list treats every typo as "development".
  it('allows the bypass only in explicit dev environments', () => {
    for (const env of ['development', 'dev', 'local', 'test']) {
      expect(new AuthConfig({ ENVIRONMENT: env }).isBypassAllowed(), env).toBe(true);
    }
  });

  it('refuses the bypass for production and near-miss names', () => {
    for (const env of ['production', 'prod', 'staging', 'Preview', 'prodcution', 'PRODUCTION']) {
      expect(new AuthConfig({ ENVIRONMENT: env }).isBypassAllowed(), env).toBe(false);
    }
  });

  it('refuses the bypass when ENVIRONMENT is unset', () => {
    // The safe default: a deploy that forgets ENVIRONMENT must not open auth.
    expect(new AuthConfig({}).isBypassAllowed()).toBe(false);
  });

  it('normalizes case and whitespace', () => {
    expect(new AuthConfig({ ENVIRONMENT: '  Development  ' }).isBypassAllowed()).toBe(true);
    expect(new AuthConfig({ ENVIRONMENT: '' }).getEnvironment()).toBe('production');
  });

  it('defaults the environment to production', () => {
    expect(new AuthConfig({}).getEnvironment()).toBe('production');
    expect(new AuthConfig({ ENVIRONMENT: 'staging' }).getEnvironment()).toBe('staging');
  });

  it('maps absent identity vars to null', () => {
    const auth = new AuthConfig({});
    expect(auth.getDevAuthEmail()).toBeNull();
    expect(auth.getDemoUserEmail()).toBeNull();
    expect(auth.getTeamDomain()).toBeNull();
    expect(auth.getPolicyAud()).toBeNull();
    expect(auth.isDemoMode()).toBe(false);
  });
});

describe('AppConfiguration.validate', () => {
  it('is clean for a development deployment', () => {
    // A bypass in development is intended, so it is not reported, and the
    // unset private-host default matches the environment.
    expect(config({ ENVIRONMENT: 'development' }).validate()).toEqual([]);
    expect(config({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'dev@example.com' }).validate()).toEqual([]);
  });

  it('does not raise a security warning about private hosts in development', () => {
    // Enabling private hosts in development is the expected local setup, so it
    // produces no security warning — only the "no effect" note, since
    // development already allows them.
    const warnings = config({ ENVIRONMENT: 'development', ALLOW_PRIVATE_BACKEND_HOSTS: 'true' }).validate();
    expect(warnings.some((w) => /Security/.test(w))).toBe(false);
  });

  it('flags a private-host opt-in that contradicts the environment', () => {
    // Setting the flag to the value the environment already implies is a no-op
    // that looks effective. Saying so beats leaving a setting that silently does
    // nothing.
    const devTrue = config({ ENVIRONMENT: 'development', ALLOW_PRIVATE_BACKEND_HOSTS: 'true' }).validate();
    expect(devTrue.some((w) => /no effect/.test(w))).toBe(true);
    const prodFalse = config({ ENVIRONMENT: 'production', ALLOW_PRIVATE_BACKEND_HOSTS: 'false' }).validate();
    expect(prodFalse.some((w) => /no effect/.test(w))).toBe(true);
  });

  it('is clean for a production deployment with no bypasses', () => {
    expect(config({ ENVIRONMENT: 'production' }).validate()).toEqual([]);
  });

  it('flags a malformed numeric var instead of silently defaulting', () => {
    const warnings = config({ MAX_BACKENDS_PER_USER: 'lots' }).validate();
    expect(warnings.some((w) => w.includes('MAX_BACKENDS_PER_USER'))).toBe(true);
  });

  it('flags every malformed var, not just the first', () => {
    const warnings = config({ MAX_BACKENDS_PER_USER: 'x', BACKEND_FETCH_TIMEOUT_MS: 'y', ROUTE_CACHE_TTL_SECONDS: 'z' }).validate();
    expect(warnings).toHaveLength(3);
  });

  it('warns that a bypass identity is present but inert in production', () => {
    // Not a vulnerability on its own — the allow-list already blocks it — but
    // shipping it means one ENVIRONMENT edit from a full account takeover.
    const warnings = config({ ENVIRONMENT: 'production', DEV_AUTH_EMAIL: 'test@example.com' }).validate();
    expect(warnings.some((w) => /DEV_AUTH_EMAIL/.test(w) && /Security/.test(w))).toBe(true);
  });

  it('does not warn about an active bypass in development, where it is intended', () => {
    // The allow-list in `isBypassAllowed` is the control that keeps a bypass out
    // of production; re-reporting the expected local setup every boot would be
    // noise that trains an operator to ignore this output.
    const warnings = config({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'test@example.com', DEMO_MODE: 'true' }).validate();
    expect(warnings).toEqual([]);
  });

  it('warns when private backend origins are enabled in production', () => {
    // This is the SSRF opt-in; enabling it silently is how a hardened default
    // gets undone.
    const warnings = config({ ENVIRONMENT: 'production', ALLOW_PRIVATE_BACKEND_HOSTS: 'true' }).validate();
    expect(warnings.some((w) => /ALLOW_PRIVATE_BACKEND_HOSTS/.test(w) && /Security/.test(w))).toBe(true);
  });

  it('raises no security warning about private hosts in development', () => {
    // Enabling private hosts in development is the expected local setup, so it
    // produces no security warning. The "no effect" note is still correct there
    // (development already allows them) and is covered separately.
    const warnings = config({ ENVIRONMENT: 'development', ALLOW_PRIVATE_BACKEND_HOSTS: 'true' }).validate();
    expect(warnings.some((w) => /Security/.test(w))).toBe(false);
  });

  it('flags an unparsable TEAM_DOMAIN, which would otherwise look like an Access outage', () => {
    const warnings = config({ TEAM_DOMAIN: 'http://[bad' }).validate();
    expect(warnings.some((w) => w.includes('TEAM_DOMAIN'))).toBe(true);
  });

  it('accepts a bare or schemed TEAM_DOMAIN', () => {
    expect(config({ TEAM_DOMAIN: 'example.cloudflareaccess.com' }).validate()).toEqual([]);
    expect(config({ TEAM_DOMAIN: 'https://example.cloudflareaccess.com' }).validate()).toEqual([]);
  });

  it('flags multiple POLICY_AUD audiences, which verification rejects at runtime', () => {
    const warnings = config({ POLICY_AUD: 'aud1,aud2' }).validate();
    expect(warnings.some((w) => w.includes('POLICY_AUD'))).toBe(true);
  });
});

describe('AppConfiguration private-host override', () => {
  it('returns null when unset so the caller can follow the environment', () => {
    expect(config({}).getAllowPrivateBackendHosts()).toBeNull();
    expect(config({ ALLOW_PRIVATE_BACKEND_HOSTS: '  ' }).getAllowPrivateBackendHosts()).toBeNull();
  });

  it('parses an explicit boolean', () => {
    expect(config({ ALLOW_PRIVATE_BACKEND_HOSTS: 'true' }).getAllowPrivateBackendHosts()).toBe(true);
    expect(config({ ALLOW_PRIVATE_BACKEND_HOSTS: ' TRUE ' }).getAllowPrivateBackendHosts()).toBe(true);
    expect(config({ ALLOW_PRIVATE_BACKEND_HOSTS: 'false' }).getAllowPrivateBackendHosts()).toBe(false);
    expect(config({ ALLOW_PRIVATE_BACKEND_HOSTS: 'yes' }).getAllowPrivateBackendHosts()).toBe(false);
  });
});

describe('AppConfiguration facade', () => {
  it('delegates to its section objects', () => {
    const appConfig = config({ ENVIRONMENT: 'development', MAX_BACKENDS_PER_USER: '3' });
    expect(appConfig.getEnvironment()).toBe('development');
    expect(appConfig.isBypassAllowed()).toBe(true);
    expect(appConfig.getMaxBackendsPerUser()).toBe(3);
    expect(appConfig.authConfig).toBeInstanceOf(AuthConfig);
    expect(appConfig.routerLimits).toBeInstanceOf(RouterLimits);
  });

  it('reads a fresh value per call, so a test can rebind env', () => {
    const env: Record<string, unknown> = { MAX_BACKENDS_PER_USER: '3' };
    const appConfig = config(env);
    expect(appConfig.getMaxBackendsPerUser()).toBe(3);
    env.MAX_BACKENDS_PER_USER = '9';
    expect(appConfig.getMaxBackendsPerUser()).toBe(9);
  });

  it('treats a null env as all-defaults rather than throwing', () => {
    // `AppConfiguration.fromEnv(env)` is called from fail-soft paths where env
    // may not be shaped as expected; it must not throw there.
    expect(() => config(null).validate()).not.toThrow();
  });
});
