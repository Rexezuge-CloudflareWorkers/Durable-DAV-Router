import { AppConfiguration } from './AppConfiguration';

/**
 * Thin backward-compatible facade over `AppConfiguration`.
 * New code should inject `AppConfiguration` directly; statics remain so
 * existing call sites keep working while they migrate.
 */
class ConfigurationManager {
  public static readonly auth = {
    isDemoMode: (env: unknown): boolean => AppConfiguration.fromEnv(env).isDemoMode(),
    getEnvironment: (env: unknown): string => AppConfiguration.fromEnv(env).getEnvironment(),
    isBypassAllowed: (env: unknown): boolean => AppConfiguration.fromEnv(env).isBypassAllowed(),
  };

  public static readonly router = {
    getMaxBackendsPerUser: (env: unknown): number => AppConfiguration.fromEnv(env).getMaxBackendsPerUser(),
    getBackendFetchTimeoutMs: (env: unknown): number => AppConfiguration.fromEnv(env).getBackendFetchTimeoutMs(),
    getRouteCacheTtlSeconds: (env: unknown): number => AppConfiguration.fromEnv(env).getRouteCacheTtlSeconds(),
  };

  public static readonly site = {
    getSiteUrl: (env: unknown): string => AppConfiguration.fromEnv(env).getSiteUrl(),
  };

  public static getDebugMode(env: unknown): boolean {
    return AppConfiguration.fromEnv(env).getDebugMode();
  }
}

export { ConfigurationManager };
