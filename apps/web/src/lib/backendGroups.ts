import type { AggregatedVolume, BackendHealth, RouterBackend } from '../types';

/**
 * Presentation-only grouping of registered backends into a live backend and the
 * replicas that point at it.
 *
 * The router registers, proxies and fans out every backend identically; this
 * module decides only which rows are hidden behind an expander. Keeping it pure
 * (no hooks, no API calls) lets the two consumers — the settings registry and
 * the dashboard — share the same rule and lets the root suite test it directly.
 *
 * Grouping is flat. A backend whose parent is missing, or is itself a replica,
 * has nowhere to attach and is returned as an orphan so it is never hidden.
 * Slugs are compared case-insensitively even though the API normalizes them:
 * a hand-edited database row must not make a backend disappear.
 */
function keyOf(slug: string | null | undefined): string {
  return (slug ?? '').trim().toLowerCase();
}

export interface BackendGroup {
  live: RouterBackend;
  replicas: RouterBackend[];
}

export interface BackendGrouping {
  groups: BackendGroup[];
  orphans: RouterBackend[];
}

export function groupBackends(rows: RouterBackend[]): BackendGrouping {
  const lives = rows.filter((row) => !keyOf(row.replicaOf));
  const attached = new Set<string>();
  const groups = lives.map((live) => {
    const replicas = rows.filter((row) => keyOf(row.replicaOf) !== '' && keyOf(row.replicaOf) === keyOf(live.slug));
    for (const replica of replicas) attached.add(keyOf(replica.slug));
    return { live, replicas };
  });
  const orphans = rows.filter((row) => keyOf(row.replicaOf) !== '' && !attached.has(keyOf(row.slug)));
  return { groups, orphans };
}

/**
 * The replica relationship from the `/user/volumes` fan-out. The dashboard gets
 * this from the same response as the buckets, so it never needs the registry
 * endpoint — the dashboard makes exactly one request.
 */
export function buildReplicaOfMap(statuses: BackendHealth[]): Map<string, string | null> {
  return new Map(statuses.map((status) => [keyOf(status.slug), keyOf(status.replicaOf) || null]));
}

export interface VolumeSection {
  slug: string;
  rows: AggregatedVolume[];
  replicaOf: string | null;
  /**
  Replica sections collapsed under this one. Empty for an ungrouped section.
  */
  replicas: VolumeSection[];
}

/**
 * Fold replica sections under their live backend's section.
 *
 * Only sections the caller actually has are attached: if the live backend holds
 * no buckets, there is no section to attach to, so the replica section stays
 * top-level (with `replicaOf` set, which the caller badges) rather than taking
 * its buckets out of view. The caller forces expansion while searching for the
 * same reason — a collapsed group must never hide a search hit.
 */
export function groupVolumeSections(
  entries: ReadonlyArray<readonly [string, AggregatedVolume[]]>,
  replicaOfBySlug: ReadonlyMap<string, string | null>,
): VolumeSection[] {
  const sections: VolumeSection[] = entries.map(([slug, rows]) => ({
    slug,
    rows,
    replicaOf: replicaOfBySlug.get(keyOf(slug)) ?? null,
    replicas: [],
  }));
  const bySlug = new Map(sections.map((section) => [keyOf(section.slug), section]));
  const attached = new Set<string>();
  for (const section of sections) {
    if (!section.replicaOf) continue;
    const parent = bySlug.get(keyOf(section.replicaOf));
    if (!parent || parent === section || parent.replicaOf) continue;
    parent.replicas.push(section);
    attached.add(keyOf(section.slug));
  }
  return sections.filter((section) => !attached.has(keyOf(section.slug)));
}
