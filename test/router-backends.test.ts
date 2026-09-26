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
import type { RouterBackendRow } from '@durable-dav-router/backend-data/dao';

function row(slug: string, baseUrl = 'https://backend.example.com'): RouterBackendRow {
  return {
    id: `id-${slug}`,
    owner_email: 'user@example.com',
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
    expect(normalizeBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
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
  it('treats success and redirects as hits', () => {
    for (const s of [200, 207, 301, 302, 307, 308]) expect(classifyProbeStatus(s)).toBe('hit');
  });
  it('treats auth challenges as auth signals', () => {
    for (const s of [401, 403, 423]) expect(classifyProbeStatus(s)).toBe('auth');
  });
  it('treats missing as misses and the rest as unknown', () => {
    expect(classifyProbeStatus(404)).toBe('miss');
    expect(classifyProbeStatus(410)).toBe('miss');
    for (const s of [400, 405, 409, 500, 502]) expect(classifyProbeStatus(s)).toBe('unknown');
  });
});

describe('BackendService with fakes', () => {
  function fakeDAO(seed: RouterBackendRow[] = []) {
    const store = new Map(seed.map((r) => [r.id, { ...r }]));
    return {
      getByOwnerSlug: async (ownerEmail: string, slug: string) =>
        [...store.values()].find((r) => r.owner_email === ownerEmail.toLowerCase() && r.slug_ci === slug.toLowerCase()) ?? null,
      getById: async (id: string) => store.get(id) ?? null,
      listByOwnerEmail: async (ownerEmail: string) => [...store.values()].filter((r) => r.owner_email === ownerEmail.toLowerCase()),
      listByBackendUsernameCi: async (usernameCi: string) =>
        [...store.values()].filter((r) => (r.backend_username_ci ?? '').toLowerCase() === usernameCi.toLowerCase()),
      countByOwnerEmail: async (ownerEmail: string) => [...store.values()].filter((r) => r.owner_email === ownerEmail.toLowerCase()).length,
      create: async (input: { id: string; ownerEmail: string; slug: string; baseUrl: string; displayName: string | null; now: number }) => {
        store.set(input.id, {
          id: input.id,
          owner_email: input.ownerEmail,
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
        store.set(id, {
          ...cur,
          base_url: patch.baseUrl ?? cur.base_url,
          display_name: patch.displayName !== undefined ? patch.displayName : cur.display_name,
          backend_username: patch.backendUsername !== undefined ? patch.backendUsername : cur.backend_username,
          backend_username_ci:
            patch.backendUsername !== undefined ? (patch.backendUsername ? patch.backendUsername.toLowerCase() : null) : cur.backend_username_ci,
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
    await svc.createBackend({ ownerEmail: 'User@Example.com', slug: 'office', baseUrl: 'https://dav.example.com' });
    await expect(svc.createBackend({ ownerEmail: 'user@example.com', slug: 'office', baseUrl: 'https://other.example.com' })).rejects.toThrow();
  });

  it('enforces the per-user quota', async () => {
    const dao = fakeDAO();
    const svc = new BackendService({ DB: {} as never, MAX_BACKENDS_PER_USER: '1' }, { backendDAO: () => Promise.resolve(dao as never) });
    await svc.createBackend({ ownerEmail: 'u@example.com', slug: 'a', baseUrl: 'https://a.example.com' });
    await expect(svc.createBackend({ ownerEmail: 'u@example.com', slug: 'b', baseUrl: 'https://b.example.com' })).rejects.toThrow();
  });
});
