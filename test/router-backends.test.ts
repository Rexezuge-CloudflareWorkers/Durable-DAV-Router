import { describe, expect, it } from 'vitest';
import { BackendService, normalizeBaseUrl, normalizeSlug } from '@durable-dav-router/backend-services/router';
import {
  classifyProbeStatus,
  describeBackendFailure,
  joinBackendUrl,
  joinBackendUrlWithoutSelector,
  resolveBackend,
  rewriteDestinationForBackend,
  stripBackendSelector,
} from '@durable-dav-router/backend-services/router';
import type { BackendOwner, RouterBackendRow } from '@durable-dav-router/backend-data/dao';
import type { AccountIdentity } from '@durable-dav-router/backend-services/identity';
import { BadRequestError, ConflictError, DatabaseError, NotFoundError } from '@durable-dav-router/backend-errors';

/**
 * A resolved caller. `anchorEmail` is the account's frozen `users.email` — for a
 * pre-0004 account that is its real address; for a newer one it can be an opaque
 * `anchor-<hex>@users.invalid`. Neither the id nor the anchor changes when the
 * account's sign-in address does, which is the property every test below leans
 * on.
 */
function account(email = 'user@example.com', id = 'usr_test1'): AccountIdentity {
  return { id, email, anchorEmail: email };
}

function row(slug: string, baseUrl = 'https://backend.example.com'): RouterBackendRow {
  return {
    id: `id-${slug}`,
    owner_email: 'user@example.com',
    owner_user_id: 'usr_test1',
    slug,
    slug_ci: slug.toLowerCase(),
    base_url: baseUrl,
    display_name: null,
    created_at: 1,
    updated_at: 1,
    last_seen_at: null,
    last_status: null,
    backend_username: null,
    backend_username_ci: null,
  };
}

describe('normalizeSlug', () => {
  it('lowercases and accepts dashes', () => {
    expect(normalizeSlug('Office-1')).toBe('office-1');
  });
  it('rejects empties and specials', () => {
    expect(() => normalizeSlug('')).toThrow();
    expect(() => normalizeSlug('a/b')).toThrow();
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slash and keeps origin', () => {
    expect(normalizeBaseUrl('https://dav.example.com/')).toBe('https://dav.example.com');
  });
  it('rejects paths and credentials', () => {
    expect(() => normalizeBaseUrl('https://dav.example.com/sub')).toThrow();
    expect(() => normalizeBaseUrl('https://user:pass@dav.example.com')).toThrow();
  });
  it('rejects remote http', () => {
    expect(() => normalizeBaseUrl('http://dav.example.com')).toThrow();
    // Loopback is a private host, so it needs the explicit opt-in — the plain
    // form here is the production default.
    expect(() => normalizeBaseUrl('http://localhost:8787')).toThrow();
    expect(normalizeBaseUrl('http://localhost:8787', true)).toBe('http://localhost:8787');
  });
  it('rejects non-string input as a 400, not a TypeError', () => {
    // A JSON body with `{"slug": 1}` used to reach `raw.trim()` and throw a
    // TypeError, which surfaced as a 500.
    for (const bad of [1, null, undefined, {}, [], true]) {
      expect(() => normalizeBaseUrl(bad)).toThrow(BadRequestError);
    }
  });

  // The router fetches baseUrl on the user's behalf with the user's
  // credentials attached, and can read part of the response back to them
  // (GET /user/backends/:slug/probe). Without a host check that is an
  // authenticated egress proxy into the router's own network.
  describe('SSRF host rejection', () => {
    const blocked: Array<[string, string]> = [
      ['cloud metadata', 'https://169.254.169.254/'],
      ['link-local', 'https://169.254.1.1/'],
      ['rfc1918 10/8', 'https://10.0.0.5/'],
      ['rfc1918 172.16/12', 'https://172.20.1.1/'],
      ['rfc1918 192.168/16', 'https://192.168.1.1/'],
      ['loopback v4', 'https://127.0.0.1/'],
      ['loopback v6', 'https://[::1]/'],
      ['ipv4-mapped metadata', 'https://[::ffff:169.254.169.254]/'],
      ['unspecified', 'https://0.0.0.0/'],
      ['decimal-encoded loopback', 'https://2130706433/'],
      ['octal-encoded loopback', 'https://0177.0.0.1/'],
      ['hex-encoded loopback', 'https://0x7f000001/'],
      ['localhost name', 'https://localhost/'],
      ['localhost subdomain', 'https://anything.localhost/'],
      ['ipv6 unique-local', 'https://[fd00::1]/'],
      ['ipv6 link-local', 'https://[fe80::1]/'],
    ];
    for (const [label, url] of blocked) {
      it(`blocks ${label} (${url})`, () => {
        expect(() => normalizeBaseUrl(url)).toThrow(BadRequestError);
      });
    }
    it('allows a normal public https origin', () => {
      expect(normalizeBaseUrl('https://dav.example.com')).toBe('https://dav.example.com');
    });
    it('allows private hosts when explicitly opted in (self-hosted router)', () => {
      expect(normalizeBaseUrl('http://localhost:8787', true)).toBe('http://localhost:8787');
      expect(normalizeBaseUrl('https://10.0.0.5', true)).toBe('https://10.0.0.5');
    });
  });
});

describe('joinBackendUrl', () => {
  it('joins origin and path', () => {
    expect(joinBackendUrl('https://b.example.com', '/user/volumes')).toBe('https://b.example.com/user/volumes');
  });
  it('strips ?backend= selector when proxying', () => {
    expect(stripBackendSelector('?backend=office')).toBe('');
    expect(stripBackendSelector('?backend=office&foo=1')).toBe('?foo=1');
    expect(joinBackendUrlWithoutSelector('https://b.example.com', '/user/volumes/x', '?backend=office')).toBe(
      'https://b.example.com/user/volumes/x',
    );
  });
});

describe('describeBackendFailure', () => {
  it('explains Cloudflare 522 distinctly', () => {
    expect(describeBackendFailure(522, '')).toMatch(/could not reach/i);
  });
  it('hints Access redirect on 302', () => {
    expect(describeBackendFailure(302, '')).toMatch(/Access/i);
  });
});

describe('rewriteDestinationForBackend', () => {
  it('rewrites same-router destinations to the backend origin', () => {
    expect(rewriteDestinationForBackend('https://router.example.com/a/b', 'https://router.example.com', 'https://b.example.com')).toBe(
      'https://b.example.com/a/b',
    );
  });
  it('passes cross-origin destinations through', () => {
    expect(rewriteDestinationForBackend('https://other.example.com/a', 'https://router.example.com', 'https://b.example.com')).toBe(
      'https://other.example.com/a',
    );
  });
  it('strips the ?backend= selector when rewriting', () => {
    expect(
      rewriteDestinationForBackend(
        'https://router.example.com/a/b?backend=office&foo=1',
        'https://router.example.com',
        'https://b.example.com',
      ),
    ).toBe('https://b.example.com/a/b?foo=1');
  });
});

describe('resolveBackend', () => {
  it('resolves explicit slug case-insensitively', () => {
    const out = resolveBackend([row('a'), row('b')], 'B');
    expect(out.kind).toBe('single');
  });
  it('returns ambiguous for multiples without selector', () => {
    const out = resolveBackend([row('a'), row('b')]);
    expect(out.kind).toBe('ambiguous');
  });
  it('uses the lone backend implicitly', () => {
    const out = resolveBackend([row('solo')]);
    expect(out.kind).toBe('single');
  });
});

describe('classifyProbeStatus', () => {
  it('treats success and multi-status as hits', () => {
    for (const s of [200, 204, 207]) expect(classifyProbeStatus(s)).toBe('hit');
  });
  it('treats auth challenges as auth signals', () => {
    for (const s of [401, 403, 423]) expect(classifyProbeStatus(s)).toBe('auth');
  });
  it('treats missing as misses and the rest as unknown', () => {
    expect(classifyProbeStatus(404)).toBe('miss');
    expect(classifyProbeStatus(410)).toBe('miss');
    for (const s of [400, 405, 409, 500, 502]) expect(classifyProbeStatus(s)).toBe('unknown');
  });
  it('does not treat a redirect as proof the volume exists', () => {
    // A Cloudflare Access login redirect comes from a perfectly real backend,
    // so reading it as a hit would pin an owner route to the wrong origin for
    // the whole route-cache TTL — and make two Access-gated candidates 409
    // every bare WebDAV request for that owner. `describeBackendFailure` in the
    // same module already documents redirects as an Access symptom.
    for (const s of [301, 302, 303, 307, 308]) expect(classifyProbeStatus(s)).toBe('unknown');
  });
});

describe('BackendService with fakes', () => {
  function fakeDAO(seed: RouterBackendRow[] = []) {
    const store = new Map(seed.map((r) => [r.id, { ...r }]));
    return {
      getByOwnerSlug: async (ownerUserId: string, slug: string) =>
        [...store.values()].find((r) => r.owner_user_id === ownerUserId && r.slug_ci === slug.toLowerCase()) ?? null,
      getById: async (id: string) => store.get(id) ?? null,
      listByOwnerUserId: async (ownerUserId: string) => [...store.values()].filter((r) => r.owner_user_id === ownerUserId),
      listByBackendUsernameCi: async (usernameCi: string) =>
        [...store.values()].filter((r) => (r.backend_username_ci ?? '').toLowerCase() === usernameCi.toLowerCase()),
      countByOwnerUserId: async (ownerUserId: string) => [...store.values()].filter((r) => r.owner_user_id === ownerUserId).length,
      createGuarded: async (
        input: { id: string; owner: BackendOwner; slug: string; baseUrl: string; displayName: string | null; now: number },
        max: number,
      ): Promise<'ok' | 'duplicate' | 'quota-exceeded'> => {
        // Mirror the real statement: the quota check and the insert are one
        // atomic operation, and the (owner_user_id, slug_ci) uniqueness is a
        // constraint rather than a pre-flight SELECT.
        const { userId, anchorEmail } = input.owner;
        const slugCi = input.slug.toLowerCase();
        const exists = [...store.values()].some((r) => r.owner_user_id === userId && r.slug_ci === slugCi);
        if (exists) return 'duplicate';
        const owned = [...store.values()].filter((r) => r.owner_user_id === userId).length;
        if (owned >= max) return 'quota-exceeded';
        store.set(input.id, {
          id: input.id,
          owner_email: anchorEmail.toLowerCase(),
          owner_user_id: userId,
          slug: input.slug,
          slug_ci: slugCi,
          base_url: input.baseUrl,
          display_name: input.displayName,
          created_at: input.now,
          updated_at: input.now,
          last_seen_at: null,
          last_status: null,
          backend_username: null,
          backend_username_ci: null,
        });
        return 'ok';
      },
      create: async (input: { id: string; owner: BackendOwner; slug: string; baseUrl: string; displayName: string | null; now: number }) => {
        store.set(input.id, {
          id: input.id,
          owner_email: input.owner.anchorEmail.toLowerCase(),
          owner_user_id: input.owner.userId,
          slug: input.slug,
          slug_ci: input.slug.toLowerCase(),
          base_url: input.baseUrl,
          display_name: input.displayName,
          created_at: input.now,
          updated_at: input.now,
          last_seen_at: null,
          last_status: null,
          backend_username: null,
          backend_username_ci: null,
        });
      },
      update: async (
        id: string,
        patch: { baseUrl?: string; displayName?: string | null; now: number; backendUsername?: string | null },
      ) => {
        const cur = store.get(id);
        if (!cur) return;
        // Computed before the record so the nested ternary does not carry the
        // `undefined`-means-"unchanged" rule *and* the lowercase-or-null rule at
        // the same time.
        const usernameCi =
          patch.backendUsername === undefined
            ? cur.backend_username_ci
            : patch.backendUsername === null
              ? null
              : patch.backendUsername.toLowerCase();
        store.set(id, {
          ...cur,
          base_url: patch.baseUrl ?? cur.base_url,
          display_name: patch.displayName ?? cur.display_name,
          backend_username: patch.backendUsername ?? cur.backend_username,
          backend_username_ci: usernameCi,
          updated_at: patch.now,
        });
      },
      deleteById: async (id: string) => {
        store.delete(id);
      },
    };
  }

  it('creates then rejects duplicate slugs', async () => {
    const dao = fakeDAO();
    const svc = new BackendService({ DB: {} as never }, { backendDAO: () => Promise.resolve(dao as never) });
    await svc.createBackend({ owner: account('User@Example.com'), slug: 'office', baseUrl: 'https://dav.example.com' });
    await expect(
      svc.createBackend({ owner: account(), slug: 'office', baseUrl: 'https://other.example.com' }),
    ).rejects.toThrow();
  });

  it('resolves concurrent creates without a duplicate (uniqueness enforced in the insert)', async () => {
    // The old flow was SELECT-then-INSERT, so two concurrent requests both saw
    // a free slug and the loser surfaced a 500 carrying raw D1 constraint text.
    const dao = fakeDAO();
    const svc = new BackendService({ DB: {} as never }, { backendDAO: () => Promise.resolve(dao as never) });
    const results = await Promise.allSettled([
      svc.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'race', baseUrl: 'https://a.example.com' }),
      svc.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'race', baseUrl: 'https://b.example.com' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    // The raw driver text must never reach the client.
    expect(String(rejected.reason?.message ?? '')).not.toMatch(/UNIQUE constraint/i);
  });

  it('rejects a private backend origin in production but allows it in development', async () => {
    const prod = new BackendService({ DB: {} as never, ENVIRONMENT: 'production' } as never, {
      backendDAO: () => Promise.resolve(fakeDAO() as never),
    });
    await expect(prod.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'local', baseUrl: 'http://localhost:8787' })).rejects.toThrow(
      /private, loopback/i,
    );

    // A co-located backend is a legitimate self-hosted setup, so an unset flag
    // outside production must not block it.
    const dev = new BackendService({ DB: {} as never, ENVIRONMENT: 'development' } as never, {
      backendDAO: () => Promise.resolve(fakeDAO() as never),
    });
    await expect(dev.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'local', baseUrl: 'http://localhost:8787' })).resolves.toBeTruthy();
  });

  it('lets ALLOW_PRIVATE_BACKEND_HOSTS override the environment default', async () => {
    const prodOptIn = new BackendService({ DB: {} as never, ENVIRONMENT: 'production', ALLOW_PRIVATE_BACKEND_HOSTS: 'true' } as never, {
      backendDAO: () => Promise.resolve(fakeDAO() as never),
    });
    await expect(
      prodOptIn.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'local', baseUrl: 'http://localhost:8787' }),
    ).resolves.toBeTruthy();

    const devOptOut = new BackendService({ DB: {} as never, ENVIRONMENT: 'development', ALLOW_PRIVATE_BACKEND_HOSTS: 'false' } as never, {
      backendDAO: () => Promise.resolve(fakeDAO() as never),
    });
    await expect(devOptOut.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'local', baseUrl: 'http://localhost:8787' })).rejects.toThrow(
      /private, loopback/i,
    );
  });

  it('raises a database error instead of reporting a D1 outage as "not found"', async () => {
    // `.catch(() => null)` turned a transient D1 fault into NotFoundError, so an
    // outage was indistinguishable from a missing row — including on the
    // unauthenticated WebDAV hot path, where it produced a false 404.
    const exploding = {
      ...fakeDAO(),
      getByOwnerSlug: async () => {
        throw new Error('D1_ERROR: network');
      },
      getById: async () => {
        throw new Error('D1_ERROR: network');
      },
    };
    const svc = new BackendService({ DB: {} as never }, { backendDAO: () => Promise.resolve(exploding as never) });
    await expect(svc.getBackend(account('u@example.com', 'usr_u'), 'office')).rejects.toBeInstanceOf(DatabaseError);
  });

  it('tolerates a missing schema, which is the one legitimate degradation', async () => {
    const missingSchema = {
      ...fakeDAO(),
      getByOwnerSlug: async () => {
        const error = new Error('D1_ERROR: no such table: router_backends');
        throw error;
      },
    };
    const svc = new BackendService({ DB: {} as never }, { backendDAO: () => Promise.resolve(missingSchema as never) });
    await expect(svc.getBackend(account('u@example.com', 'usr_u'), 'office')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enforces the per-user quota', async () => {
    const dao = fakeDAO();
    const svc = new BackendService({ DB: {} as never, MAX_BACKENDS_PER_USER: '1' }, { backendDAO: () => Promise.resolve(dao as never) });
    await svc.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'a', baseUrl: 'https://a.example.com' });
    await expect(svc.createBackend({ owner: account('u@example.com', 'usr_u'), slug: 'b', baseUrl: 'https://b.example.com' })).rejects.toThrow();
  });
});
