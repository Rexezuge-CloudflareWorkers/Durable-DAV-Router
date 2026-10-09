export interface CurrentUser {
  email: string;
  /**
   * Preferred UI language (BCP 47 tag). Optional: persisted locally only
   * (`localStorage > navigator > en`).
   */
  preferredLanguage?: string | null;
}

export interface Volume {
  owner: string;
  name: string;
  fullName: string;
  description?: string | null;
  isPrivate: boolean;
  /**
   * How the owning backend anchors this bucket's `DAV:href` values.
   *
   * `base` is RFC 4918 §8.3 — hrefs carry `/owner/volume` — and is the
   * backend's default. `root` anchors them at `/` for clients that 404
   * otherwise; the backend owns that choice, and the router neither interprets
   * nor enforces it (it forwards 207 bodies verbatim).
   *
   * Optional because the router fronts arbitrary backends: one predating the
   * setting omits it, which reads as `base`.
   */
  hrefPrefixMode?: DavHrefPrefixMode;
  href: string;
  backend?: string;
  backendBaseUrl?: string;
}

export type DavHrefPrefixMode = 'base' | 'root';

export interface AggregatedVolume extends Volume {
  backend: string;
}

export interface RouterBackend {
  slug: string;
  baseUrl: string;
  displayName: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
  lastStatus: number | null;
  backendUsername?: string | null;
}

export interface BackendHealth {
  slug: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface VolumeDetail extends Volume {
  description: string | null;
  /**
   * Required here even though it is optional on `Volume`: a detail read always
   * goes through `toVolumeDetail`, which resolves a backend that omits the field
   * to the conforming `base`. Components can then render the control without
   * re-deriving that default.
   */
  hrefPrefixMode: DavHrefPrefixMode;
}

export interface BucketCredential {
  credentialId: string;
  name: string;
  username: string;
  passwordPrefix: string;
  passwordLastFour: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  /**
   * Backend-enforced. The router stores no credentials of its own, so this is
   * the backend's flag passed through verbatim; the router never decides what a
   * credential may do. See `VolumeCredentialsCard` for the toggle.
   */
  readOnly: boolean;
}

export interface CreatedBucketCredential {
  credentialId: string;
  username: string;
  password: string;
  name: string;
  expiresAt: number;
  passwordPrefix: string;
  passwordLastFour: string;
  /**
   * Echoed back so the card can show the access level that was actually
   * applied. The backend rejects a non-boolean rather than defaulting it, so a
   * value here is always one the caller asked for.
   */
  readOnly: boolean;
}

export interface DavEntry {
  href: string;
  name: string;
  path: string;
  isCollection: boolean;
  size: number | null;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
}

/**
 * One configured replication target on a backend.
 *
 * Backend-owned, proxied verbatim: the router stores nothing about a replication
 * and interprets none of it. Every field here is the backend's own projection
 * (`ReplicationRoutes.replicationProjection`), which is the only thing standing
 * between a stored credential and a client — `encrypted_secret`/`secret_iv` are
 * named nowhere in it, so they cannot reach a browser even by accident.
 *
 * `passInFlight` is not cosmetic: a non-null value *is* the backend's deletion
 * gate, so the UI can explain why a deletion has not propagated yet instead of
 * leaving the owner to wonder whether replication is broken.
 */
export interface BucketReplication {
  replicationId: string;
  targetKind: 'dav' | 'dav-volume';
  remoteUrl: string;
  remoteOwner: string;
  remoteVolume: string;
  remotePath: string;
  authKind: 'none' | 'basic' | 'bearer';
  /**
   * The backend's conflict policy, which also carries the *direction* of the
   * sync — there is no separate direction setting, so "never imports" and
   * "always wins" have to be one decision.
   *
   * `pull-only` is the one-way import: the remote is the sole writer, nothing is
   * ever pushed back, and a local version the remote would replace is preserved
   * beside it rather than overwritten. It is also the only mode
   * `mirrorDeletions` is read in.
   */
  mode: 'copy-only' | 'sync' | 'keep-both' | 'pull-only';
  /**
   * `pull-only` only. `true` makes this an exact mirror — a local path the remote
   * does not have is deleted — and `false` (the default) is a safe copy, where
   * the remote's content is imported and nothing local is ever destroyed. It is
   * the one boolean in this projection that decides whether a sync pass can
   * *remove* a file the bucket holds, so the row badges it rather than burying
   * it in a list of fields.
   *
   * Optional for the same reason `Volume.hrefPrefixMode` is: the router fronts
   * arbitrary backends and a backend predating `mirror_deletions` omits it. The
   * omission is only reachable where the badge is not rendered, because such a
   * backend cannot hold a `pull-only` target — its `mode` validator has never
   * accepted the value — so "absent reads as off" is never a claim about a
   * mirror-deletion the backend might actually perform.
   */
  mirrorDeletions?: boolean;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'partial' | 'failed' | null;
  lastError: string | null;
  consecutiveFailures: number;
  passInFlight: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * One recorded sync decision worth explaining.
 *
 * `kind: 'deletion'` means a deletion was propagated between the two sides. Those
 * are recorded as well as conflicts precisely because they are the irreversible
 * ones, and `keptPath` is the only place a losing version survives — so a client
 * that cannot see it cannot resolve the decision it is being told about.
 */
export interface ReplicationConflict {
  conflictId: string;
  path: string;
  winner: 'local' | 'remote';
  keptPath: string | null;
  kind: 'conflict' | 'deletion';
  detectedAt: number;
  resolvedAt: number | null;
}
