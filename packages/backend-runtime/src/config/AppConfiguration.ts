import { EnvParser } from './EnvParser';

import { AuthConfig } from './sections/AuthConfig';
import { RouterLimits } from './sections/RouterLimits';

/**
 * `TEAM_DOMAIN` is used to build the JWKS URL, so a scheme-less value throws
 * inside `createRemoteJWKSet` and is swallowed into a 401 by the JWT strategy.
 * Detect it at startup instead.
 */
function isParsableTeamDomain(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * One `AppConfiguration` per env object.
 *
 * A Worker's `env` is the same object for every request in an isolate, and five
 * call sites read a setting from it on the request path: `BackendService`, the two
 * `AccessAuthService` strategies, `getProxyTimeoutMs` and
 * `getRouteCacheTtlSeconds`. Each was building its own instance — and each
 * instance builds two section objects — so a single proxied WebDAV request
 * constructed four configurations to read two numbers.
 *
 * Memoising on the env object is what makes that one instance, and it is what a
 * `Tokens.AppConfig` binding would have bought for the injectable case. It is
 * *not* used for that case: `getProxyTimeoutMs` and `getRouteCacheTtlSeconds` are
 * free functions over an arbitrary `env` — they are called from fail-soft paths
 * that receive a bare object from a test double and have no container to resolve
 * from. A token could not reach them; a `WeakMap` can, and reaches every site.
 *
 * Weak, so a caller passing a fresh object per call does not leak; a fresh object
 * per call also means a fresh configuration, which is the correct reading of "this
 * is not the env I was given before".
 */
const INSTANCES = new WeakMap<object, AppConfiguration>();

/**
 * A shared instance for a nullish or non-object env.
 *
 * Every reader on this facade is total over a missing env — `EnvParser.readString`
 * returns `undefined` and each getter falls back to its default — which is
 * deliberate: these paths are reached with a partial or absent env from tests and
 * from `getProxyTimeoutMs`, where a `TypeError` would replace a default with a 500.
 */
/**
 * Memo for a nullish env, held in an object so the lazily-initialised assignment
 * inside the function below is not a write to a top-level binding.
 *
 * Lazy because a module-level `new AppConfiguration` above the class is a
 * use-before-declaration; a function is hoisted, and the object is populated long
 * before any call can reach it.
 */
const EMPTY_MEMO: { instance?: AppConfiguration } = {};

function emptyConfiguration(): AppConfiguration {
  EMPTY_MEMO.instance ??= new AppConfiguration(null);
  return EMPTY_MEMO.instance;
}

/**
 * Injectable instance view over Durable-DAV-Router environment configuration.
 *
 * Composed of focused section objects (`RouterLimits`, `AuthConfig`) so the
 * facade stays thin. A service that takes configuration injects it through its
 * `deps` seam; the free functions that read a single setting off an arbitrary
 * `env` go through `fromEnv`, which hands back the same instance for the same env.
 */
class AppConfiguration {
  private readonly router: RouterLimits;
  private readonly auth: AuthConfig;

  constructor(private readonly env: unknown) {
    this.router = new RouterLimits(env);
    this.auth = new AuthConfig(env);
  }

  public static fromEnv(env: unknown): AppConfiguration {
    if (env === null || typeof env !== 'object') return emptyConfiguration();
    const existing = INSTANCES.get(env);
    if (existing) return existing;
    const created = new AppConfiguration(env);
    INSTANCES.set(env, created);
    return created;
  }

  public get routerLimits(): RouterLimits {
    return this.router;
  }

  public get authConfig(): AuthConfig {
    return this.auth;
  }

  public getMaxBackendsPerUser(): number {
    return this.router.getMaxBackendsPerUser();
  }

  public getBackendFetchTimeoutMs(): number {
    return this.router.getBackendFetchTimeoutMs();
  }

  public getRouteCacheTtlSeconds(): number {
    return this.router.getRouteCacheTtlSeconds();
  }

  /**
   * Whether a user may register a private or loopback backend origin.
   *
   * Mirrors `BackendService`'s default so both layers agree: unset means
   * "follow the environment", and only an explicit value overrides that.
   * `BackendService` is the enforcement point; this exists so `validate()` can
   * report a contradictory setting at startup.
   */
  public getAllowPrivateBackendHosts(): boolean | null {
    // Tri-state, not boolean-with-default: `BackendService` distinguishes an
    // unset value ("follow the environment") from an explicit one, so coercing
    // a typo to `false` here would report a setting the deployment never made.
    return EnvParser.optionalBoolean(this.env, 'ALLOW_PRIVATE_BACKEND_HOSTS');
  }

  public isDemoMode(): boolean {
    return this.auth.isDemoMode();
  }

  public getEnvironment(): string {
    return this.auth.getEnvironment();
  }

  public isBypassAllowed(): boolean {
    return this.auth.isBypassAllowed();
  }

  public getDevAuthEmail(): string | null {
    return this.auth.getDevAuthEmail();
  }

  public getDemoUserEmail(): string | null {
    return this.auth.getDemoUserEmail();
  }

  public getTeamDomain(): string | null {
    return this.auth.getTeamDomain();
  }

  public getPolicyAud(): string | null {
    return this.auth.getPolicyAud();
  }

  /**
   * Fail-fast misconfiguration report. Returns human-readable warnings for
   * unsafe or malformed configuration; empty means clean.
   *
   * Call once at worker startup (not per-request) and log the result. The
   * warnings exist because every failure mode below is silent at runtime: a
   * bad numeric var quietly falls back to its default, and an auth bypass set
   * in a production environment quietly authenticates every unauthenticated
   * request as a fixed identity.
   */
  public validate(): string[] {
    const warnings: string[] = [];
    const numericKeys = ['MAX_BACKENDS_PER_USER', 'BACKEND_FETCH_TIMEOUT_MS', 'ROUTE_CACHE_TTL_SECONDS'];
    for (const key of numericKeys) {
      if (!EnvParser.isValidPositiveInt(this.env, key)) {
        warnings.push(`Invalid configuration: ${key} must be a positive integer`);
      }
    }
    // Security: a bypass identity must never be reachable in production. Even
    // though `isBypassAllowed()` already refuses it there, shipping the value
    // at all means one `ENVIRONMENT` edit away from a full account takeover.
    if (!this.isBypassAllowed() && (this.getDevAuthEmail() !== null || this.isDemoMode())) {
      warnings.push(
        `Security: DEV_AUTH_EMAIL/DEMO_MODE is set while ENVIRONMENT=${this.getEnvironment()}. ` +
          `The bypass is ignored in this environment; remove the variable so it cannot become live if ENVIRONMENT changes.`,
      );
    }
    // An *active* bypass is not reported: it can only happen in
    // {development, dev, local, test}, where it is the intended setup, and the
    // allow-list in `isBypassAllowed` is the control that keeps it out of
    // production. The reverse case above — a bypass present but inert — is
    // reported, because that is the one that is one config edit from live.
    // An unparsable TEAM_DOMAIN silently degrades JWT verification into a 401
    // for every real user, which reads as an Access outage rather than a typo.
    const teamDomain = this.getTeamDomain();
    if (teamDomain !== null && !isParsableTeamDomain(teamDomain)) {
      warnings.push(`Invalid configuration: TEAM_DOMAIN must be a hostname (got ${JSON.stringify(teamDomain)})`);
    }
    const policyAud = this.getPolicyAud();
    if (policyAud !== null && policyAud.includes(',')) {
      warnings.push('Invalid configuration: POLICY_AUD must be a single audience; multiple values are not supported');
    }
    // A production deployment that allows private backend origins has re-opened
    // the SSRF surface that the default exists to close, so make it loud rather
    // than leaving it as a silent opt-in nobody notices is active.
    const allowPrivate = this.getAllowPrivateBackendHosts();
    if (allowPrivate === true && !this.isBypassAllowed()) {
      warnings.push(
        `Security: ALLOW_PRIVATE_BACKEND_HOSTS=true while ENVIRONMENT=${this.getEnvironment()}. ` +
          `Users can register loopback and private-network origins, which turns the router into a proxy into its own network.`,
      );
    }
    // A value that is neither `true` nor `false` is worse than either: it reads
    // as configured, enforces nothing, and is invisible in the warning above.
    if (allowPrivate === null && EnvParser.string(this.env, 'ALLOW_PRIVATE_BACKEND_HOSTS', '').trim().length > 0) {
      warnings.push(`Invalid configuration: ALLOW_PRIVATE_BACKEND_HOSTS must be true or false`);
    }
    if (allowPrivate === true && this.isBypassAllowed()) {
      warnings.push(
        `Note: ALLOW_PRIVATE_BACKEND_HOSTS=true has no effect while ENVIRONMENT=${this.getEnvironment()} (private hosts are already allowed).`,
      );
    }
    if (allowPrivate === false && !this.isBypassAllowed()) {
      warnings.push(
        `Note: ALLOW_PRIVATE_BACKEND_HOSTS=false has no effect while ENVIRONMENT=${this.getEnvironment()} (private hosts are already denied).`,
      );
    }
    return warnings;
  }
}

export { AppConfiguration };
