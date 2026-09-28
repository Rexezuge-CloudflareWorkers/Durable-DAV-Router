import { RouterBackendDAO } from '@durable-dav-router/backend-data/dao';
import type { BackendOwner, RouterBackendRow } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';
import { isMissingSchemaError } from '@durable-dav-router/backend-data/utils';
import { BadRequestError, ConflictError, DatabaseError, ForbiddenError, NotFoundError } from '@durable-dav-router/backend-errors';
import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import { TimestampUtil, UUIDUtil } from '@durable-dav-router/shared/utils';
import { isPrivateOrInternalHost } from '@durable-dav-router/shared/utils';
import type { AccountIdentity } from '../identity/UserIdentityService';
import { stripTrailingSlashes } from './BackendProxyService';

interface BackendServiceEnv {
  DB: D1Queryable;
  MAX_BACKENDS_PER_USER?: string;
  ALLOW_PRIVATE_BACKEND_HOSTS?: string;
}

interface BackendServiceDeps {
  backendDAO?: () => Promise<RouterBackendDAO>;
  config?: AppConfiguration;
}

const SLUG_MAX_LENGTH = 64;
const DISPLAY_NAME_MAX_LENGTH = 100;

function isValidSlugChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-';
}

function normalizeSlug(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestError('slug must be a string');
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH) {
    throw new BadRequestError(`Invalid backend slug (1-${SLUG_MAX_LENGTH} chars)`);
  }
  const first = slug[0] ?? '';
  const last = slug.at(-1) ?? '';
  if (first === '-' || last === '-' || !isValidSlugChar(first) || !isValidSlugChar(last)) {
    throw new BadRequestError('Invalid backend slug (must start/end alphanumeric)');
  }
  for (const ch of slug) {
    if (!isValidSlugChar(ch)) throw new BadRequestError('Invalid backend slug (lowercase alphanumeric + dashes)');
  }
  return slug;
}

function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') throw new BadRequestError('displayName must be a string or null');
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, DISPLAY_NAME_MAX_LENGTH) : null;
}

/**
 * Normalize a user-supplied backend origin to a bare `scheme://host:port`.
 *
 * The router fetches this URL on the user's behalf, with the user's
 * credentials attached, and can read part of the response back to them
 * (`GET /user/backends/:slug/probe`). A user could therefore point
 * `baseUrl` at cloud metadata (`169.254.169.254`), a private service, or a
 * loopback admin port and use the router as an authenticated egress proxy into
 * its own network. Private and loopback hosts are therefore rejected.
 *
 * `ALLOW_PRIVATE_BACKEND_HOSTS` opts a self-hosted deployment back in, since
 * pointing the router at a Durable-DAV on the same host is legitimate there.
 * That check is syntactic: a public hostname can still resolve to a private
 * address via DNS rebinding, so hardened deployments should pin an origin
 * allow-list as well.
 */
function normalizeBaseUrl(raw: unknown, allowPrivateHosts = false): string {
  if (typeof raw !== 'string') throw new BadRequestError('baseUrl must be a string');
  const trimmed = stripTrailingSlashes(raw.trim());
  if (!trimmed) throw new BadRequestError('baseUrl is required');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BadRequestError('Invalid baseUrl');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestError('baseUrl must be http(s)');
  }
  if (url.username || url.password) throw new BadRequestError('baseUrl must not embed credentials');
  // Router proxies from the backend origin root. Reject sub-paths so
  // `joinBackendUrl` stays a pure origin + path join.
  if (url.pathname !== '/' && url.pathname !== '') throw new BadRequestError('baseUrl must be an origin (no path)');
  if (url.search || url.hash) throw new BadRequestError('baseUrl must be an origin (no query/fragment)');
  const isLocalDev = isPrivateOrInternalHost(url.hostname);
  if (isLocalDev && !allowPrivateHosts) {
    throw new BadRequestError('baseUrl must not target a private, loopback, or link-local address');
  }
  // Plaintext to a public origin would put bucket credentials on the wire.
  // A private host is only reachable from inside the deployment, so requiring
  // https there too would just block the legitimate self-hosted case.
  if (!isLocalDev && url.protocol === 'http:') {
    throw new BadRequestError('http baseUrl is only allowed for loopback backends (use https otherwise)');
  }
  return url.origin;
}

function isTruthyFlag(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * Whether this deployment may register a private/loopback backend origin.
 *
 * Precedence:
 *  1. `ALLOW_PRIVATE_BACKEND_HOSTS` set explicitly → that value wins, so a
 *     self-hosted deployment can opt in and a locked-down one can opt out.
 *  2. Unset → allowed only outside production, so `wrangler dev` and the
 *     integration suite work against a co-located backend without extra setup.
 *  3. Production with nothing set → denied. Locked by default is the safe
 *     reading: the cost of being wrong in the other direction is an
 *     authenticated SSRF proxy into the deployment's own network.
 */
function isPrivateBackendHostAllowed(env: BackendServiceEnv, config: AppConfiguration): boolean {
  const raw = env.ALLOW_PRIVATE_BACKEND_HOSTS;
  return typeof raw === 'string' && raw.trim().length > 0 ? isTruthyFlag(raw) : config.isBypassAllowed();
}

/**
 * Narrow a resolved account to what a `router_backends` row needs.
 *
 * The id is the ownership key; the anchor is the frozen value the `owner_email`
 * foreign key resolves against. `account.email` — the *mutable* address — is
 * deliberately dropped rather than passed along: it is precisely the value the
 * anchor exists to stop depending on, so no DAO below this line can reach it.
 */
function toBackendOwner(account: AccountIdentity): BackendOwner {
  return { userId: account.id, anchorEmail: account.anchorEmail };
}

/**
 * Wrap a D1 read so a genuine database fault surfaces as a 5xx instead of
 * being flattened into "not found".
 *
 * The only legitimate degradation is a missing schema (migrations not yet
 * applied), which yields `null`. Everything else is rethrown as a
 * `DatabaseError`; previously a transient D1 error was indistinguishable from
 * an absent row, which turned outages into 404s and skipped write guards.
 */
async function d1Read<T>(operation: () => Promise<T>, context: string, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isMissingSchemaError(error)) return fallback;
    throw new DatabaseError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The per-user backend registry.
 *
 * Every owner-scoped method takes the caller's resolved `AccountIdentity`
 * rather than an address, and narrows it internally. The id is the identity: it
 * is stable across an address change, so a user who moves their email keeps
 * every backend registered under the old one. The anchor rides along because
 * `router_backends.owner_email` is a foreign key into `users(email)` and that
 * column is now immutable.
 */
class BackendService {
  private readonly deps: Required<BackendServiceDeps>;
  private readonly allowPrivateHosts: boolean;

  constructor(
    private readonly env: BackendServiceEnv,
    deps: BackendServiceDeps = {},
  ) {
    this.deps = {
      backendDAO: () => Promise.resolve(new RouterBackendDAO(env.DB)),
      config: AppConfiguration.fromEnv(env),
      ...deps,
    };
    this.allowPrivateHosts = isPrivateBackendHostAllowed(env, this.deps.config);
  }

  /**
   * Row window for owner-scoped and owner-routed listings.
   *
   * Derived from the quota rather than hardcoded: a fixed window silently
   * truncates once the quota is raised, and a truncated candidate set turns a
   * real ambiguity into a false "lone backend" (routing a request to the
   * wrong origin) and hides registered backends from `GET /user/backends`.
   * One row of headroom so a full quota is distinguishable from a truncation.
   */
  private listWindow(): number {
    return Math.max(100, this.deps.config.getMaxBackendsPerUser() + 1);
  }

  private async findBackend(owner: AccountIdentity, slug: string): Promise<RouterBackendRow | null> {
    const dao = await this.deps.backendDAO();
    return d1Read(() => dao.getByOwnerSlug(owner.id, slug), 'lookup router backend', null);
  }

  public async createBackend(input: {
    owner: AccountIdentity;
    slug: string;
    baseUrl: string;
    displayName?: string | null;
  }): Promise<RouterBackendRow> {
    const account = input.owner;
    const slug = normalizeSlug(input.slug);
    const baseUrl = normalizeBaseUrl(input.baseUrl, this.allowPrivateHosts);
    const displayName = input.displayName === undefined || input.displayName === null ? null : normalizeDisplayName(input.displayName);
    const dao = await this.deps.backendDAO();
    // The uniqueness and quota checks below exist only to produce a friendly
    // error; the database constraints are the actual enforcement, so they are
    // what the create relies on. See `createGuarded`.
    const existing = await this.findBackend(account, slug);
    if (existing) throw new ConflictError('Backend slug already exists');
    const max = this.deps.config.getMaxBackendsPerUser();
    const count = await d1Read(() => dao.countByOwnerUserId(account.id), 'count router backends', 0);
    if (count >= max) throw new ForbiddenError(`Backend limit reached (${max})`);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    const created = await dao.createGuarded({ id, owner: toBackendOwner(account), slug, baseUrl, displayName, now }, max);
    if (created === 'duplicate') throw new ConflictError('Backend slug already exists');
    if (created === 'quota-exceeded') throw new ForbiddenError(`Backend limit reached (${max})`);
    const row = await dao.getById(id);
    if (!row) throw new NotFoundError('Backend not found after create');
    return row;
  }

  public async getBackend(owner: AccountIdentity, slug: string): Promise<RouterBackendRow> {
    const row = await this.findBackend(owner, slug);
    if (!row) throw new NotFoundError('Backend not found');
    return row;
  }

  /**
   * Look a backend up by its primary key, ignoring ownership.
   *
   * Used to revalidate a cached owner→backend route against the authoritative
   * row before forwarding. A cached entry can outlive the backend it names
   * (deleted, or repointed at a different `base_url`), and forwarding to a
   * stale origin is what a wasted request cannot detect in time.
   */
  public async findBackendById(id: string): Promise<RouterBackendRow | null> {
    if (typeof id !== 'string' || id.length === 0) return null;
    const dao = await this.deps.backendDAO();
    return d1Read(() => dao.getById(id), 'lookup router backend by id', null);
  }

  public async listBackends(owner: AccountIdentity): Promise<RouterBackendRow[]> {
    const dao = await this.deps.backendDAO();
    return d1Read(() => dao.listByOwnerUserId(owner.id, this.listWindow()), 'list router backends', []);
  }

  public async updateBackend(
    owner: AccountIdentity,
    slug: string,
    patch: { baseUrl?: string; displayName?: string | null },
  ): Promise<RouterBackendRow> {
    const dao = await this.deps.backendDAO();
    const row = await this.getBackend(owner, slug);
    const updates: { baseUrl?: string; displayName?: string | null } = {};
    if (patch.baseUrl !== undefined) updates.baseUrl = normalizeBaseUrl(patch.baseUrl, this.allowPrivateHosts);
    if (patch.displayName !== undefined) {
      updates.displayName = patch.displayName === null ? null : normalizeDisplayName(patch.displayName);
    }
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao.update(row.id, { ...updates, now });
    const updated = await dao.getById(row.id);
    if (!updated) throw new NotFoundError('Backend not found after update');
    return updated;
  }

  public async deleteBackend(owner: AccountIdentity, slug: string): Promise<void> {
    const row = await this.getBackend(owner, slug);
    const dao = await this.deps.backendDAO();
    await dao.deleteById(row.id);
  }

  /**
   * Liveness bookkeeping. Never throws: a failed probe must not fail the
   * request that triggered it. Errors are logged so a persistent D1 fault is
   * visible rather than silently dropping status updates forever.
   */
  public async recordProbe(owner: AccountIdentity, slug: string, status: number | null): Promise<void> {
    const dao = await this.deps.backendDAO();
    const row = await this.findBackend(owner, slug);
    if (!row) return;
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao.update(row.id, { now, lastSeenAt: now, lastStatus: status }).catch((error: unknown) => {
      console.warn(`recordProbe failed for backend ${slug}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  public async recordBackendUsername(owner: AccountIdentity, slug: string, username: string | null): Promise<void> {
    const dao = await this.deps.backendDAO();
    const row = await this.findBackend(owner, slug);
    if (!row) return;
    const normalized = typeof username === 'string' && username.trim() ? username.trim() : null;
    // Skip the write when nothing changed: this runs after every proxied
    // `/user/me`, and an unconditional UPDATE would churn `updated_at` and
    // contend on the same D1 row.
    if ((row.backend_username ?? null) === normalized) return;
    await dao
      .update(row.id, { now: TimestampUtil.getCurrentUnixTimestampInSeconds(), backendUsername: normalized })
      .catch((error: unknown) => {
        console.warn(`recordBackendUsername failed for backend ${slug}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /**
   * Backends whose cached per-backend username matches `usernameCi`.
   *
   * This drives unauthenticated WebDAV owner routing, so the result set is
   * attacker-influenced: any account can register a backend that reports a
   * victim handle. Callers must therefore never forward the caller's
   * credentials while deciding, and must treat a non-unique result as
   * ambiguous. See `probeCandidateBackends`.
   */
  public async listByBackendUsername(usernameCi: unknown): Promise<RouterBackendRow[]> {
    if (typeof usernameCi !== 'string') return [];
    const trimmed = usernameCi.trim().toLowerCase();
    if (!trimmed) return [];
    const dao = await this.deps.backendDAO();
    return d1Read(() => dao.listByBackendUsernameCi(trimmed, this.listWindow()), 'list backends by username', []);
  }
}

export { BackendService, normalizeSlug, normalizeBaseUrl, normalizeDisplayName, isPrivateBackendHostAllowed, toBackendOwner };
export type { BackendServiceEnv, BackendServiceDeps };
