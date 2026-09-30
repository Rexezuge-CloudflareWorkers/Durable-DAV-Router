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
