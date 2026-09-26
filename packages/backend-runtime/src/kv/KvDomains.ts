// Single-KV keyspace: one `CACHE` binding, domains separated by key prefix.
//
// Rationale: D1 stays the source of truth (joins, transactions). KV is a
// loss-tolerant, read-heavy cache only — a miss or eviction must always be
// recoverable by recompute. Call sites never touch `env.CACHE` directly;
// they go through `KvCache` with a closed `KvDomainName` registry so prefixes
// cannot collide and TTL/size policy lives in one table.
//
// The router proxies to backends and caches only what it cannot cheaply
// recompute: the owner/volume -> backend resolution. A D1 miss costs one indexed
// row read, but a WebDAV sync re-sends the same owner/volume for every operation
// in the run, and an unresolvable route costs N parallel volume-root probes.
// Everything else the router touches is either authoritative in D1 or derived
// per request.
//
// This registry is a closed union on purpose: a typo cannot silently create a
// new keyspace, and the TTL/size policy for every cached value lives in one
// table rather than at each call site.

const KV_KEY_VERSION = 'v1';
const KV_MAX_KEY_LENGTH = 512;
const KV_MIN_TTL_SECONDS = 60;

type KvDomainName = 'davRoute';

interface KvDomainDef {
  ttlSeconds?: number;
  maxValueBytes: number;
  description: string;
}

const KV_DOMAINS: Record<KvDomainName, KvDomainDef> = {
  davRoute: {
    ttlSeconds: 86_400,
    maxValueBytes: 4096,
    description: 'Owner/volume to owning backend resolution; buckets rarely change so long-lived (24h), invalidated on volume/backend mutation plus self-heal on forward 404/410.',
  },
};

function fnv1aHex(input: string): string {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sanitizeSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) throw new Error('KV key segment must not be empty.');
  return encodeURIComponent(trimmed);
}

function buildKvKey(domain: KvDomainName, parts: readonly string[]): string {
  const def = KV_DOMAINS[domain];
  if (!def) throw new Error(`Unknown KV domain: ${domain}.`);
  if (parts.length === 0) throw new Error(`KV domain ${domain} requires at least one key part.`);
  const prefix = `${domain}:${KV_KEY_VERSION}:`;
  const joined = parts.map((part) => sanitizeSegment(part)).join(':');
  const full = prefix + joined;
  if (full.length <= KV_MAX_KEY_LENGTH) return full;
  // Deterministic fallback: a miss just recomputes, so a 32-bit digest is fine.
  return `${prefix}h:${fnv1aHex(joined)}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function clampTtl(ttlSeconds: number | undefined, domain: KvDomainName): number | undefined {
  const effective = ttlSeconds ?? KV_DOMAINS[domain].ttlSeconds;
  if (effective === undefined) return undefined;
  return Number.isFinite(effective) ? Math.max(KV_MIN_TTL_SECONDS, Math.floor(effective)) : undefined;
}

export { KV_DOMAINS, KV_KEY_VERSION, KV_MAX_KEY_LENGTH, KV_MIN_TTL_SECONDS };
export { buildKvKey, clampTtl, fnv1aHex, utf8ByteLength };
export type { KvDomainDef, KvDomainName };
