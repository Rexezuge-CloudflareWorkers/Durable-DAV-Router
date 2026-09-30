// Deciding which backend serves `/:owner/:volume`, with no I/O in it.
//
// Split out of `RouterDavProxyRoutes` because the hard part of that route is not
// the forwarding — it is the policy. A cached entry has to be revalidated, an
// ambiguous owner has to be probed, and each outcome has to decide three things
// at once: what to answer, whether the cached entry may be written, and whether
// it may be deleted. Interleaved with the fetches, that policy was a 149-line
// function whose every branch needed a Hono request, a D1 double, a KV double and
// a `fetch` stub to reach.
//
// `decideOwnerRoute` takes the *results* of those reads and returns the decision,
// so every branch below is asserted as a plain function call. `RouterDavProxyRoutes`
// keeps the I/O and applies what it is told. The two halves are deliberately
// adjacent in time: the caller reads, decides once, then acts.
import type { CachedRoute } from '@durable-dav-router/backend-services/router';
import type { AutoResolution } from '@durable-dav-router/backend-services/router';
import type { RoutableBackend } from '@durable-dav-router/backend-services/router';



/**
 * What a cached route's revalidation against D1 established.
 *
 * Three answers rather than two. `unknown` — the read could not be performed —
 * has to stay distinct from `disproved`, because `disproved` is what authorises an
 * eviction: conflating them let a database outage spend deletes from the daily
 * allowance on every request until D1 recovered.
 */
export type RevalidationVerdict =
  | { kind: 'confirmed'; backend: RoutableBackend }
  | { kind: 'disproved' }
  | { kind: 'unknown' };

/**
A cached entry this request consulted, plus why it is being distrusted.
*/
export interface StaleRoute {
  route: CachedRoute;
  proven: boolean;
}

/**
 * What to do with the route cache once the answer is known.
 *
 * `replace` and `evict` are the only two writes this plane performs, and both are
 * budgeted: the free plan allots 1,000 writes and 1,000 deletes per day against
 * 100,000 reads, so an operation spent on an unchanged value is an operation
 * stolen from a real change. `none` must be the common answer, and every branch
 * below decides it here rather than at the write site — the comparison is the
 * policy, and a policy with two implementations has none.
 */
export type CacheAction = 'none' | 'replace' | 'evict';

/**
 * The decision, in the order the caller acts on it.
 *
 * `forward` is the only one that reaches a backend. Everything else is a status
 * the router owes the client on the backend's behalf.
 */
export type OwnerRouteDecision =
  | { kind: 'forward'; backend: RoutableBackend; cache: CacheAction }
  | { kind: 'not-found'; cache: CacheAction }
  | { kind: 'unavailable'; cache: CacheAction }
  | { kind: 'conflict'; cache: CacheAction };

export interface OwnerRouteInput {
  /**
   * The cached entry this request consulted and found untrustworthy, if any.
   *
   * `proven` is the difference between a fact and a hint: D1 disagreeing with
   * the entry settles it, an origin that merely 404'd does not. A non-`proven`
   * entry is only written when the re-resolution actually disagrees with it.
   */
  stale: StaleRoute | null;
  /**
  The revalidation result. `null` when there was no cached entry to revalidate.
  */
  verdict: RevalidationVerdict | null;
  /**
  Backends whose cached per-backend username matches the path's `owner`.
  */
  candidates: RoutableBackend[];
  /**
  The `?backend=` / `X-Backend` selector, trimmed. `null` for a bare client URL.
  */
  explicit: string | null;
  /**
   * The probe fan-out's result, or `null` when no probe ran.
   *
   * `null` covers the two single-backend paths, where `resolveBackend`
   * short-circuits without probing — which is also why those never cache.
   */
  probe: AutoResolution | null;
}

/**
 * Pick the backend, and pick the cache write — together, because they are one
 * question.
 */
export function decideOwnerRoute(input: OwnerRouteInput): OwnerRouteDecision {
  const { stale, verdict, candidates, explicit, probe } = input;

  // A confirmed revalidation already named the origin, so the fan-out below is
  // skipped entirely — that is the whole point of the lookaside.
  if (verdict?.kind === 'confirmed') {
    return { kind: 'forward', backend: verdict.backend, cache: 'none' };
  }

  if (candidates.length === 0) {
    // No backend claims the handle. A *proven* stale entry has to go — D1 has
    // said it is wrong — while a merely-suspect one stays, because "nothing
    // matched this time" and "the entry is wrong" are different claims and only
    // the first one is established.
    return { kind: 'not-found', cache: evictionFor(stale, null) };
  }

  const resolved = resolveBySlug(candidates, explicit);

  if (resolved.kind === 'not-found') {
    // The caller named a backend that is not theirs. Vague on purpose: the
    // message must not enumerate another tenant's slugs.
    return { kind: 'not-found', cache: evictionFor(stale, null) };
  }

  if (resolved.kind === 'single') {
    // A lone backend resolves without probing, so an entry here would hold a
    // value the same request's D1 read already produced: a scarce KV write spent
    // to save a D1 read, 100× the wrong way round. `none` is deliberate.
    return { kind: 'forward', backend: resolved.backend, cache: evictionFor(stale, resolved.backend) };
  }

  // Ambiguous: bare client URLs carry no `?backend=` hint, so the candidates are
  // probed and the unique owner wins rather than failing dumb clients with 409.
  switch (probe?.kind) {
    case 'single': {
      // Bare by construction — an explicit selector never yields ambiguous — so
      // this is cacheable, and the one case the lookaside exists for: this is
      // the resolution that actually skipped a fan-out.
      //
      // `replace` still means "store it, *unless that is what is already there*".
      // A stale entry that this re-resolution happens to confirm must not cost a
      // write, which is the comparison a client that 404s in a loop would pay on
      // every single request.
      return { kind: 'forward', backend: probe.backend, cache: stale && sameRoute(stale.route, probe.backend) ? 'none' : 'replace' };
    }
    case 'not-found': {
      return { kind: 'not-found', cache: evictionFor(stale, null) };
    }
    case 'ambiguous': {
      // A genuine collision: the same volume on several backends. Never cached.
      return { kind: 'conflict', cache: evictionFor(stale, null) };
    }
    // `unavailable`, and `probe: null` on an ambiguous set: an unanswered probe is
    // an unreachable one, not a miss, and guessing `not-found` would delete a
    // route on a guess. Either way there is no evidence — `unavailable` means the
    // candidate origins are unreachable, which says nothing about whether the
    // route is wrong — so a merely-suspect entry stays and only a D1-proven one
    // goes.
    default: {
      const evict = stale?.proven === true;
      return { kind: 'unavailable', cache: evict ? 'evict' : 'none' };
    }
  }
}

/**
 * Whether a stale entry may be evicted, given what replaced it.
 *
 * The comparison is the write-budget decision in its purest form: if the
 * re-resolution names the backend already cached, the entry holds the right
 * answer and every write is pure churn. That is what a client 404ing on every
 * inner path used to pay, forever, while every response stayed correct.
 */
function evictionFor(stale: StaleRoute | null, replacement: RoutableBackend | null): CacheAction {
  if (!stale) return 'none';
  return replacement && sameRoute(stale.route, replacement) ? 'none' : 'evict';
}

function sameRoute(a: CachedRoute, b: RoutableBackend): boolean {
  const backendId = typeof b.id === 'string' && b.id.length > 0 ? b.id : b.slug;
  return a.backendId === backendId && a.baseUrl === b.base_url;
}

/**
 * Local copy of `resolveBackend`'s matching rule, narrowed to `RoutableBackend`.
 *
 * `BackendProxyService`'s matching rule, with its input type narrowed to the same
 * three fields. The rule is three lines and is what the `explicit`-selector and
 * lone-backend branches both hinge on.
 */
function resolveBySlug(
  backends: RoutableBackend[],
  explicitSlug?: string | null,
): { kind: 'single'; backend: RoutableBackend } | { kind: 'not-found' } | { kind: 'ambiguous'; backends: RoutableBackend[] } {
  // Trim before testing for presence: a whitespace-only selector is an absent
  // one, and treating it as a slug would answer 404 for a request that should
  // have been resolved by probing.
  const explicit = typeof explicitSlug === 'string' ? explicitSlug.trim() : '';
  if (explicit) {
    const match = backends.find((b) => b.slug.toLowerCase() === explicit.toLowerCase());
    return match ? { kind: 'single', backend: match } : { kind: 'not-found' };
  }
  if (backends.length === 0) return { kind: 'not-found' };
  return backends.length === 1 ? { kind: 'single', backend: backends[0] } : { kind: 'ambiguous', backends };
}


export {type RoutableBackend} from '@durable-dav-router/backend-services/router';