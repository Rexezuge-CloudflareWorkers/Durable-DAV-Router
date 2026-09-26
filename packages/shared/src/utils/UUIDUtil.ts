/**
 * Primary keys for `router_backends`.
 *
 * The id is internal and never appears on the wire (routes address backends by
 * `slug`), so a v4 UUID in canonical dashed form is the whole requirement.
 */
class UUIDUtil {
  public static getRandomUUID(): string {
    return crypto.randomUUID();
  }
}

export { UUIDUtil };
