/**
 * The only two strings that mean a flag is set.
 *
 * Absence is meaningful and is not `false`: see `optionalBoolean`.
 */
const BOOLEAN_LITERALS: Readonly<Record<string, boolean | undefined>> = Object.freeze({ true: true, false: false });

class EnvParser {
  public static positiveInt(env: unknown, key: string, defaultValue: string): number {
    const value = this.readString(env, key);
    const parsed = Number(value ?? defaultValue);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number(defaultValue);
  }

  public static isValidPositiveInt(env: unknown, key: string): boolean {
    const value = this.readString(env, key);
    if (value === undefined) return true;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0;
  }

  public static string(env: unknown, key: string, defaultValue: string): string {
    return this.readString(env, key) ?? defaultValue;
  }

  /**
   * Tri-state flag read: `true`, `false`, or "unset".
   *
   * A flag that is present but unrecognised must not silently become `false`.
   * `ALLOW_PRIVATE_BACKEND_HOSTS` in particular decides whether users may
   * register private and loopback backend origins, so `ALLOW_PRIVATE_BACKEND_HOSTS=banana`
   * has to be reportable rather than indistinguishable from an explicit opt-out
   * — `validate()` is what turns that into a startup warning.
   */
  public static optionalBoolean(env: unknown, key: string): boolean | null {
    const raw = this.readString(env, key);
    if (raw === undefined || raw.trim().length === 0) return null;
    // A lookup rather than two comparisons: `1`, `yes`, `on` and typos are then
    // absent from the table instead of "false", which is the distinction the
    // caller needs — `null` is unset, and unset is not the same as an opt-out.
    const flag = BOOLEAN_LITERALS[raw.trim().toLowerCase()];
    return flag === undefined ? null : flag;
  }

  /**
   * Flag read, defaulting when unset or unrecognised.
   *
   * Trims and case-folds deliberately. Configuration here is typed by hand into
   * wrangler vars, a `.dev.vars` file, and CI secrets, and `TRUE` and `" true "`
   * are the same answer as `true`. Two other boolean readers in this repository
   * already normalized before comparing, which meant `DEMO_MODE=True` was
   * honoured on one path and ignored on another — an operator watching a flag
   * silently do nothing has no way to tell that from a typo, which is the class
   * of misconfiguration `AppConfiguration.validate()` exists to surface.
   */
  public static boolean(env: unknown, key: string, defaultValue: string): boolean {
    const parsed = this.optionalBoolean(env, key);
    // The fallback comes from `ConfigurationDefaults`, i.e. it is a compile-time
    // constant rather than operator input, so it only has to be recognisable —
    // an unrecognised default is a bug in this repository, not a setting.
    return parsed === null ? defaultValue.trim().toLowerCase() === 'true' : parsed;
  }

  /**
   * Read one variable.
   *
   * Defensive about the env shape: this is reached from fail-soft paths
   * (`getProxyTimeoutMs`) where `env` may be null or a partial object, and a
   * TypeError there would replace a default with a 500.
   */
  private static readString(env: unknown, key: string): string | undefined {
    if (env === null || typeof env !== 'object') return undefined;
    const value = (env as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
}

export { EnvParser };
