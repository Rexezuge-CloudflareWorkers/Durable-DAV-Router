import { EnvParser } from '../EnvParser';
import { DEFAULT_BACKEND_FETCH_TIMEOUT_MS, DEFAULT_MAX_BACKENDS_PER_USER, DEFAULT_ROUTE_CACHE_TTL_SECONDS } from '../ConfigurationDefaults';

// Router registry + reverse-proxy limits (Strategy: one section per
// config concern so `AppConfiguration` stays a thin Facade).
class RouterLimits {
  constructor(private readonly env: unknown) {}

  public getMaxBackendsPerUser(): number {
    return EnvParser.positiveInt(this.env, 'MAX_BACKENDS_PER_USER', DEFAULT_MAX_BACKENDS_PER_USER);
  }

  public getBackendFetchTimeoutMs(): number {
    return EnvParser.positiveInt(this.env, 'BACKEND_FETCH_TIMEOUT_MS', DEFAULT_BACKEND_FETCH_TIMEOUT_MS);
  }

  public getRouteCacheTtlSeconds(): number {
    return EnvParser.positiveInt(this.env, 'ROUTE_CACHE_TTL_SECONDS', DEFAULT_ROUTE_CACHE_TTL_SECONDS);
  }
}

export { RouterLimits };
