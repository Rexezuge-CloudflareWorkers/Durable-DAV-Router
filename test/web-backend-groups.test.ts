import { describe, expect, it } from 'vitest';
import { buildReplicaOfMap, groupBackends, groupVolumeSections } from '../apps/web/src/lib/backendGroups';
import type { AggregatedVolume, BackendHealth, RouterBackend } from '../apps/web/src/types';

function backend(slug: string, replicaOf: string | null = null): RouterBackend {
  return {
    slug,
    baseUrl: `https://${slug}.example.com`,
    displayName: null,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: null,
    lastStatus: null,
    replicaOf,
  };
}

function volume(slug: string): AggregatedVolume {
  return {
    owner: 'alice',
    name: `vol-${slug}`,
    fullName: `alice/vol-${slug}`,
    href: `/alice/vol-${slug}`,
    isPrivate: false,
    backend: slug,
  };
}

function health(slug: string, replicaOf: string | null): BackendHealth {
  return { slug, ok: true, status: 200, replicaOf };
}

describe('groupBackends', () => {
  it('collapses replicas under their live backend and keeps the original order', () => {
    const grouping = groupBackends([backend('live'), backend('replica-1', 'live'), backend('other'), backend('replica-2', 'live')]);
    expect(grouping.groups.map((group) => [group.live.slug, group.replicas.map((r) => r.slug)])).toEqual([
      ['live', ['replica-1', 'replica-2']],
      ['other', []],
    ]);
    expect(grouping.orphans).toEqual([]);
  });

  it('matches parent slugs case-insensitively', () => {
    const grouping = groupBackends([backend('Live'), backend('replica-1', 'LIVE')]);
    expect(grouping.groups[0]?.replicas.map((r) => r.slug)).toEqual(['replica-1']);
    expect(grouping.orphans).toEqual([]);
  });

  it('never hides a row whose parent is missing or is itself a replica', () => {
    const grouping = groupBackends([backend('live'), backend('mid', 'live'), backend('child', 'mid'), backend('gone', 'missing')]);
    expect(grouping.groups.map((group) => group.live.slug)).toEqual(['live']);
    expect(grouping.groups[0]?.replicas.map((r) => r.slug)).toEqual(['mid']);
    expect(grouping.orphans.map((r) => r.slug).sort()).toEqual(['child', 'gone']);
  });
});

describe('buildReplicaOfMap', () => {
  it('maps each status to its parent and folds an empty value to live', () => {
    const map = buildReplicaOfMap([health('LIVE', null), health('replica-1', 'LIVE'), health('replica-2', '')]);
    expect([...map]).toEqual([
      ['live', null],
      ['replica-1', 'live'],
      ['replica-2', null],
    ]);
  });
});

describe('groupVolumeSections', () => {
  it('folds replica sections under the live section', () => {
    const sections = groupVolumeSections(
      [
        ['live', [volume('live')]],
        ['replica-1', [volume('replica-1')]],
        ['other', [volume('other')]],
      ],
      buildReplicaOfMap([health('live', null), health('replica-1', 'live'), health('other', null)]),
    );
    expect(sections.map((section) => [section.slug, section.replicas.map((r) => r.slug)])).toEqual([
      ['live', ['replica-1']],
      ['other', []],
    ]);
  });

  it('keeps a replica section top-level when the live backend holds no buckets', () => {
    const sections = groupVolumeSections(
      [
        ['replica-1', [volume('replica-1')]],
      ],
      buildReplicaOfMap([health('live', null), health('replica-1', 'live')]),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ slug: 'replica-1', replicaOf: 'live' });
    expect(sections[0]?.replicas).toEqual([]);
  });

  it('refuses to attach a section to itself or to another replica', () => {
    const sections = groupVolumeSections(
      [
        ['live', [volume('live')]],
        ['mid', [volume('mid')]],
        ['child', [volume('child')]],
        ['self', [volume('self')]],
      ],
      new Map([
        ['live', null],
        ['mid', 'live'],
        ['child', 'mid'],
        ['self', 'self'],
      ]),
    );
    // `mid` is attached to live; `child` stays top-level because its parent is
    // a replica, and `self` because a section cannot be its own parent.
    expect(sections.map((section) => section.slug)).toEqual(['live', 'child', 'self']);
    expect(sections[0]?.replicas.map((r) => r.slug)).toEqual(['mid']);
  });
});
