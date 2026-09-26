/**
 * Canonical SSRF host helpers (Layer 0).
 *
 * Why this exists: bracket/dot stripping, encoded-numeric detection, and IPv6
 * blocklists were previously duplicated across URL-policy call sites, so a fix
 * in one copy missed the other. Only the shared host predicates live here;
 * policy decisions (allowed schemes, whether loopback is permitted) stay with
 * the callers.
 */

const MAX_URL_LENGTH = 2048;

/**
IPv4 ranges that must never be reachable through a user-supplied URL.
*/
const PRIVATE_IPV4_RANGES: readonly RegExp[] = [
  /^0\./, // "this network"
  /^10\./, // RFC 1918
  /^127\./, // loopback
  /^169\.254\./, // link-local, incl. cloud metadata (169.254.169.254)
  /^172\.(?:1[6-9]|2\d|3[01])\./, // RFC 1918
  /^192\.0\.0\./, // IETF protocol assignments
  /^192\.0\.2\./, // TEST-NET-1
  /^192\.168\./, // RFC 1918
  /^198\.(?:18|19)\./, // benchmarking
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^224\./, // multicast
  /^240\./, // reserved
  /^255\./, // broadcast
];

function stripBrackets(host: string): string {
  const h = host.trim();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function stripTrailingDot(host: string): string {
  const unbracketed = stripBrackets(host);
  let end = unbracketed.length;
  while (end > 0 && unbracketed.charAt(end - 1) === '.') end -= 1;
  return unbracketed.slice(0, end);
}

function isEncodedNumericHost(host: string): boolean {
  const h = host.toLowerCase();
  if (/^0x[\da-f]+$/i.test(h) || /^\d+$/.test(h) || /^0[0-7]+(?:\.0[0-7]+)+$/.test(h) || /^0x[\da-f.]+$/i.test(h)) return true;
  if (/^[\d.]+$/.test(h) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function isBlockedIpv6Host(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === '::' ||
    h === '::1' ||
    h.startsWith('::ffff:') ||
    /^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(h) ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    /^fe[89ab]/i.test(h) ||
    h.startsWith('ff') ||
    h.startsWith('fe80:')
  );
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '::1' || h === '0.0.0.0' || h === '::' || h.startsWith('::ffff:127.');
}

function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost');
}

/**
 * True when a URL host resolves to this machine or a private network.
 *
 * Intended for user-supplied URLs that the server will subsequently fetch.
 * Such a URL turns the process into a proxy into its own network: without
 * this, a user-supplied `baseUrl` can point at cloud metadata, a database
 * host, or a loopback admin port, and the response is readable by the caller.
 *
 * Encoded-numeric hosts are included because `http://2130706433/` and
 * `http://0177.0.0.1/` are ordinary-looking strings that name `127.0.0.1`
 * after parsing.
 *
 * This is a *syntactic* check. A public hostname can still resolve to a
 * private address (DNS rebinding), so deployments that need a hard guarantee
 * must additionally pin an origin allow-list.
 */
function isPrivateOrInternalHost(hostname: string): boolean {
  const host = stripTrailingDot(hostname).toLowerCase();
  if (
    host.length === 0 ||
    isLocalhostName(host) ||
    isLoopbackHost(host) ||
    isBlockedIpv6Host(host) ||
    isEncodedNumericHost(host) ||
    host.includes(':')
  )
    return true; // any other IPv6 form; all are covered above
  return PRIVATE_IPV4_RANGES.some((range) => range.test(host));
}

export {
  MAX_URL_LENGTH,
  PRIVATE_IPV4_RANGES,
  stripBrackets,
  stripTrailingDot,
  isEncodedNumericHost,
  isBlockedIpv6Host,
  isLoopbackHost,
  isLocalhostName,
  isPrivateOrInternalHost,
};
