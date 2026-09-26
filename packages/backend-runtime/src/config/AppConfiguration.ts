import { EnvParser } from './EnvParser';
import { DEFAULT_DEBUG_MODE, DEFAULT_SITE_URL } from './ConfigurationDefaults';

import { AuthConfig } from './sections/AuthConfig';
import { RouterLimits } from './sections/RouterLimits';

/**
 * Injectable instance view over Durable-DAV-Router environment configuration.
 *
 * Composed of focused section objects (`RouterLimits`, `AuthConfig`) so the
 * facade stays thin. `ConfigurationManager` statics delegate here for
 * backward compatibility. New code should accept `AppConfiguration` via
 * constructor injection so env parsing is stubbable.
 */
class AppConfiguration {
  private readonly router: RouterLimits;
  private readonly auth: AuthConfig;

  constructor(private readonly env: unknown) {
    this.router = new RouterLimits(env);
    this.auth = new AuthConfig(env);
  }

  public static fromEnv(env: unknown): AppConfiguration {
    return new AppConfiguration(env);
  }

  public get routerLimits(): RouterLimits {
    return this.router;
  }

  public get authConfig(): AuthConfig {
    return this.auth;
  }

  public getDebugMode(): boolean {
    return EnvParser.boolean(this.env, 'DEBUG_MODE', DEFAULT_DEBUG_MODE);
  }

  public getSiteUrl(): string {
    let url = EnvParser.string(this.env, 'SITE_URL', DEFAULT_SITE_URL);
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  public getMaxBackendsPerUser(): number {
    return this.router.getMaxBackendsPerUser();
  }

  public getBackendFetchTimeoutMs(): number {
    return this.router.getBackendFetchTimeoutMs();
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
   * Fail-fast misconfiguration report. Returns human-readable warnings
   * for explicitly-set but malformed numeric vars; empty means clean.
   * Call at worker startup or in tests — never per-request.
   */
  public validate(): string[] {
    const warnings: string[] = [];
    const numericKeys = ['MAX_BACKENDS_PER_USER', 'BACKEND_FETCH_TIMEOUT_MS'];
    for (const key of numericKeys) {
      if (!EnvParser.isValidPositiveInt(this.env, key)) {
        warnings.push(`Invalid configuration: ${key} must be a positive integer`);
      }
    }
    return warnings;
  }
}

export { AppConfiguration };
