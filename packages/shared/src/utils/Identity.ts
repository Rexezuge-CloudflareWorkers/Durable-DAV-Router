/**
 * Email format validation (Layer 0).
 *
 * The router stores only the lowercased email that Cloudflare Access asserts;
 * there is no user-supplied email to validate on the write path, so this is a
 * cheap sanity check on an identity the router did not choose.
 *
 * Deliberately permissive about the local part (RFC 5322 allows far more than
 * this) and strict about the obvious mistakes: no whitespace, exactly one `@`,
 * a dot-separated domain, and a bounded total length.
 */
const EMAIL_FORMAT_RE = /^[^@\s]+@[^\s@][^\s.@]*\.[^\s@]+$/;

const MAX_EMAIL_LENGTH = 254;

function isValidEmailFormat(raw: string): boolean {
  return raw !== '' && raw.length <= MAX_EMAIL_LENGTH && EMAIL_FORMAT_RE.test(raw);
}

export { isValidEmailFormat, MAX_EMAIL_LENGTH };
