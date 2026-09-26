/**
 * Unix timestamps, in seconds.
 *
 * Seconds (not milliseconds) because that is what the D1 columns store, so the
 * conversion lives in exactly one place rather than at each write site.
 */
class TimestampUtil {
  public static getCurrentUnixTimestampInSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }
}

export { TimestampUtil };
