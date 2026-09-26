import { describe, expect, it } from 'vitest';
import { BackendService, normalizeBaseUrl, normalizeSlug } from '@durable-dav-router/backend-services/router';
import {
  joinBackendUrl,
  resolveBackend,
  rewriteDestinationForBackend,
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

describe('BackendService with fakes', () => {
  function fakeDAO(seed: RouterBackendRow[] = []) {
    const store = new Map(seed.map((r) => [r.id, { ...r }]));
    return {
      getByOwnerSlug: async (ownerEmail: string, slug: string) =>
        [...store.values()].find((r) => r.owner_email === ownerEmail.toLowerCase() && r.slug_ci === slug.toLowerCase()) ?? null,
      getById: async (id: string) => store.get(id) ?? null,
      listByOwnerEmail: async (ownerEmail: string) => [...store.values()].filter((r) => r.owner_email === ownerEmail.toLowerCase()),
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
        });
      },
      update: async (id: string, patch: { baseUrl?: string; displayName?: string | null; now: number }) => {
        const cur = store.get(id);
        if (!cur) return;
        store.set(id, {
          ...cur,
          base_url: patch.baseUrl ?? cur.base_url,
          display_name: patch.displayName !== undefined ? patch.displayName : cur.display_name,
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
