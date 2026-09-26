import { RouterBackendDAO } from '@durable-dav-router/backend-data/dao';
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable } from '@durable-dav-router/backend-data/utils';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@durable-dav-router/backend-errors';
import { AppConfiguration } from '@durable-dav-router/backend-runtime/config';
import { TimestampUtil, UUIDUtil } from '@durable-dav-router/shared/utils';
import { stripTrailingSlashes } from './BackendProxyService';

interface BackendServiceEnv {
  DB: D1Queryable;
  MAX_BACKENDS_PER_USER?: string;
}

interface BackendServiceDeps {
  backendDAO?: () => Promise<RouterBackendDAO>;
  config?: AppConfiguration;
}

function isValidSlugChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-';
}

function normalizeSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0 || slug.length > 64) {
    throw new BadRequestError('Invalid backend slug (1-64 chars)');
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

function normalizeBaseUrl(raw: string): string {
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
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && !url.hostname.endsWith('.localhost')) {
    throw new BadRequestError('http baseUrl is only allowed for localhost (use https otherwise)');
  }
  return url.origin;
}

class BackendService {
  private readonly deps: Required<BackendServiceDeps>;

  constructor(
    private readonly env: BackendServiceEnv,
    deps: BackendServiceDeps = {},
  ) {
    this.deps = {
      backendDAO: () => Promise.resolve(new RouterBackendDAO(env.DB)),
      config: AppConfiguration.fromEnv(env),
      ...deps,
    };
  }

  public async createBackend(input: { ownerEmail: string; slug: string; baseUrl: string; displayName?: string | null }): Promise<RouterBackendRow> {
    const ownerEmail = input.ownerEmail.toLowerCase();
    const slug = normalizeSlug(input.slug);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const displayName = input.displayName?.trim() ? input.displayName.trim().slice(0, 100) : null;
    const dao = await this.deps.backendDAO();
    const existing = await dao.getByOwnerSlug(ownerEmail, slug).catch(() => null);
    if (existing) throw new ConflictError('Backend slug already exists');
    const max = this.deps.config.getMaxBackendsPerUser();
    const count = await dao.countByOwnerEmail(ownerEmail).catch(() => 0);
    if (count >= max) throw new ForbiddenError(`Backend limit reached (${max})`);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    await dao.create({ id, ownerEmail, slug, baseUrl, displayName, now });
    const created = await dao.getById(id);
    if (!created) throw new NotFoundError('Backend not found after create');
    return created;
  }

  public async getBackend(ownerEmail: string, slug: string): Promise<RouterBackendRow> {
    const dao = await this.deps.backendDAO();
    const row = await dao.getByOwnerSlug(ownerEmail.toLowerCase(), slug).catch(() => null);
    if (!row) throw new NotFoundError('Backend not found');
    return row;
  }

  public async listBackends(ownerEmail: string): Promise<RouterBackendRow[]> {
    const dao = await this.deps.backendDAO();
    return dao.listByOwnerEmail(ownerEmail.toLowerCase(), 100).catch(() => []);
  }

  public async updateBackend(
    ownerEmail: string,
    slug: string,
    patch: { baseUrl?: string; displayName?: string | null },
  ): Promise<RouterBackendRow> {
    const dao = await this.deps.backendDAO();
    const row = await this.getBackend(ownerEmail, slug);
    const updates: { baseUrl?: string; displayName?: string | null } = {};
    if (patch.baseUrl !== undefined) updates.baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (patch.displayName !== undefined) {
      updates.displayName = patch.displayName?.trim() ? patch.displayName.trim().slice(0, 100) : null;
    }
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao.update(row.id, { ...updates, now });
    const updated = await dao.getById(row.id);
    if (!updated) throw new NotFoundError('Backend not found after update');
    return updated;
  }

  public async deleteBackend(ownerEmail: string, slug: string): Promise<void> {
    const row = await this.getBackend(ownerEmail, slug);
    const dao = await this.deps.backendDAO();
    await dao.deleteById(row.id);
  }

  public async recordProbe(ownerEmail: string, slug: string, status: number | null): Promise<void> {
    const dao = await this.deps.backendDAO();
    const row = await dao.getByOwnerSlug(ownerEmail.toLowerCase(), slug).catch(() => null);
    if (!row) return;
    await dao
      .update(row.id, {
        now: TimestampUtil.getCurrentUnixTimestampInSeconds(),
        lastSeenAt: TimestampUtil.getCurrentUnixTimestampInSeconds(),
        lastStatus: status,
      })
      .catch(() => undefined);
  }
}

export { BackendService, normalizeSlug, normalizeBaseUrl };
export type { BackendServiceEnv, BackendServiceDeps };
