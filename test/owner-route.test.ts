import { describe, expect, it } from 'vitest';
import { decideOwnerRoute } from '../apps/api/src/workers/routes/ownerRoute';
import type { CachedRoute } from '@durable-dav-router/backend-services/router';
import type { OwnerRouteInput, RoutableBackend } from '../apps/api/src/workers/routes/ownerRoute';

/**
 * The routing policy, with no I/O.
 *
 * Every case here previously needed a Hono request, a D1 double, a KV double and
 * a `fetch` stub to reach, which is why `handleProxy` was one 149-line function:
 * the parts worth asserting were the parts that were hardest to assert. This is
 * that part, called directly.
 *
 * The end-to-end equivalents live in `test/router-dav-proxy.test.ts`, including
 * the operation counts for the caching cases. These pin the *policy* — which
 * backend, and which cache write — independently of whether the plumbing that
 * produces those inputs still works.
 */

const backend = (slug: string, baseUrl = `https://${slug}.example.com`): RoutableBackend => ({ id: slug, slug, base_url: baseUrl });

const cachedFor = (slug: string, baseUrl = `https://${slug}.example.com`): CachedRoute => ({
  backendId: slug,
  slug,
  baseUrl,
});

const input = (over: Partial<OwnerRouteInput> = {}): OwnerRouteInput => ({
  stale: null,
  verdict: null,
  candidates: [],
  explicit: null,
  probe: null,
  ...over,
});

const staleOf = (slug: string, proven: boolean) => ({ route: cachedFor(slug), proven });

describe('decideOwnerRoute — a confirmed revalidation is authoritative', () => {
  it('forwards to the revalidated backend without consulting the candidates', () => {
    // This is what the lookaside buys: no D1 owner lookup and no probe fan-out.
    // The candidates here are deliberately absent, so an implementation that
    // consulted them would answer `not-found`.
    const decision = decideOwnerRoute(
      input({ verdict: { kind: 'confirmed', backend: backend('solo') }, candidates: [], stale: staleOf('solo', false) }),
    );
    expect(decision).toEqual({ kind: 'forward', backend: backend('solo'), cache: 'none' });
  });

  it('falls back to the fan-out when the revalidation only says `unknown`', () => {
    // A database that could not answer the question is not one that answered it.
    // Treating `unknown` as `disproved` is what spent KV deletes on every request
    // during an outage.
    const decision = decideOwnerRoute(
      input({ verdict: { kind: 'unknown' }, candidates: [backend('a'), backend('b')], probe: { kind: 'single', backend: backend('b') } }),
    );
    expect(decision).toMatchObject({ kind: 'forward', backend: backend('b') });
  });
});

describe('decideOwnerRoute — candidate matching', () => {
  it('answers not-found when nothing claims the handle', () => {
    expect(decideOwnerRoute(input()).kind).toBe('not-found');
  });

  it('evicts a proven entry when nothing claims the handle', () => {
    expect(decideOwnerRoute(input({ stale: staleOf('gone', true) }))).toEqual({ kind: 'not-found', cache: 'evict' });
  });

  it('evicts even a merely-suspect entry when nothing claims the handle', () => {
    // Unlike the unreachable-candidates case below, zero candidates is an
    // authoritative statement, not a hint: the owner lookup came back from D1
    // with no backend holding this handle, so the cached entry cannot be right
    // whatever produced it. `proven` distinguishes "D1 said so" from "an origin
    // 404'd"; it does not license keeping an entry D1 has disproven by omission.
    expect(decideOwnerRoute(input({ stale: staleOf('suspect', false) }))).toEqual({ kind: 'not-found', cache: 'evict' });
  });

  it('does not evict when the lone backend already cached is the one that answers', () => {
    expect(decideOwnerRoute(input({ stale: staleOf('solo', false), candidates: [backend('solo') ] }))).toEqual({
      kind: 'forward',
      backend: backend('solo'),
      cache: 'none',
    });
  });

  it('evicts when the lone backend differs from the one cached', () => {
    expect(decideOwnerRoute(input({ stale: staleOf('old', true), candidates: [backend('new')] }))).toMatchObject({
      kind: 'forward',
      cache: 'evict',
    });
  });

  it('resolves an explicit selector case-insensitively', () => {
    expect(decideOwnerRoute(input({ candidates: [backend('a'), backend('b')], explicit: ' B ' }))).toMatchObject({
      kind: 'forward',
      backend: backend('b'),
    });
  });

  it('treats a whitespace-only selector as absent rather than as an unknown slug', () => {
    // Otherwise a client that sent `?backend=%20` gets 404 for a request that
    // probing would have resolved.
    expect(decideOwnerRoute(input({ candidates: [backend('a'), backend('b')], explicit: ' '.repeat(3), probe: { kind: 'single', backend: backend('a') } }))).toMatchObject(
      { kind: 'forward', backend: backend('a') },
    );
  });

  it('answers not-found for a selector that names no registered backend', () => {
    // Vague on purpose: the message must not enumerate another tenant's slugs.
    expect(decideOwnerRoute(input({ candidates: [backend('a')], explicit: 'theirs' })).kind).toBe('not-found');
  });
});

describe('decideOwnerRoute — ambiguous owners', () => {
  const ambiguous = (over: Partial<OwnerRouteInput> = {}) => input({ candidates: [backend('a'), backend('b')], ...over });

  it('forwards to the unique owner and stores the route', () => {
    expect(decideOwnerRoute(ambiguous({ probe: { kind: 'single', backend: backend('b') } }))).toEqual({
      kind: 'forward',
      backend: backend('b'),
      cache: 'replace',
    });
  });

  it('spends nothing when the probe confirms what is already cached', () => {
    // The write-budget case in its purest form: the entry holds the right
    // answer, so the write would be pure churn — and a client that 404s in a
    // loop pays this on every single request.
    expect(decideOwnerRoute(input({ stale: staleOf('b', false), candidates: [backend('a'), backend('b')], probe: { kind: 'single', backend: backend('b') } }))).toEqual(
      { kind: 'forward', backend: backend('b'), cache: 'none' },
    );
  });

  it('replaces when the probe names a different backend', () => {
    expect(decideOwnerRoute(input({ stale: staleOf('a', true), candidates: [backend('a'), backend('b')], probe: { kind: 'single', backend: backend('b') } }))).toEqual(
      { kind: 'forward', backend: backend('b'), cache: 'replace' },
    );
  });

  it('answers not-found, and evicts, when no candidate holds the volume', () => {
    expect(decideOwnerRoute(ambiguous({ stale: staleOf('a', false), probe: { kind: 'not-found' } }))).toEqual({ kind: 'not-found', cache: 'evict' });
  });

  it('answers 502 while the origins are unreachable, keeping a suspect entry', () => {
    expect(decideOwnerRoute(ambiguous({ stale: staleOf('a', false), probe: { kind: 'unavailable' } }))).toEqual({ kind: 'unavailable', cache: 'none' });
  });

  it('still evicts a proven entry while the origins are unreachable', () => {
    // D1 already established the entry names a `base_url` that no longer
    // exists; an unreachable candidate set adds nothing to that.
    expect(decideOwnerRoute(ambiguous({ stale: staleOf('a', true), probe: { kind: 'unavailable' } }))).toEqual({ kind: 'unavailable', cache: 'evict' });
  });

  it('treats an unanswered probe as unreachable rather than as a miss', () => {
    // `probe: null` reaches here only if a caller forgot to run one; guessing
    // `not-found` would delete a route on a guess.
    expect(decideOwnerRoute(input({ candidates: [backend('a'), backend('b')] }))).toMatchObject({ kind: 'unavailable' });
  });

  it('reports a genuine collision, and never caches it', () => {
    expect(decideOwnerRoute(ambiguous({ probe: { kind: 'ambiguous', backends: [backend('a'), backend('b')] } }))).toEqual({ kind: 'conflict', cache: 'none' });
  });
});

describe('decideOwnerRoute — cache action is a policy, not an optimisation', () => {
  it('never writes for a lone-backend owner', () => {
    // `resolveBackend` short-circuits a one-candidate set without probing, so an
    // entry here would cache a value the same request's D1 read already
    // produced: a scarce KV write spent to save a cheap D1 read.
    const decisions = [null, { kind: 'not-found' }, { kind: 'single', backend: backend('a') }].map((probe) =>
      decideOwnerRoute(input({ candidates: [backend('a')], probe: probe as OwnerRouteInput['probe'] })).cache,
    );
    expect(decisions).toEqual(['none', 'none', 'none']);
  });

  it('falls back to the slug when a backend row has no id', () => {
    // `putCachedRoute` keys on `id`, and a row written before one existed has
    // none; using the slug keeps the key stable instead of storing `undefined`.
    const decision = decideOwnerRoute(input({ stale: { route: cachedFor('a'), proven: true }, candidates: [{ slug: 'a', base_url: 'https://a.example.com' }] }));
    expect(decision).toEqual({ kind: 'forward', backend: { slug: 'a', base_url: 'https://a.example.com' }, cache: 'none' });
  });
});
