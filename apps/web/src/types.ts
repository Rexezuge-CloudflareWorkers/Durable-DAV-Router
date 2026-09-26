export interface CurrentUser {
  email: string;
  username?: string | null;
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
  href: string;
  backend?: string;
  backendBaseUrl?: string;
}

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
}

export interface BackendHealth {
  slug: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface VolumeDetail extends Volume {
  description: string | null;
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
}

export interface CreatedBucketCredential {
  credentialId: string;
  username: string;
  password: string;
  name: string;
  expiresAt: number;
  passwordPrefix: string;
  passwordLastFour: string;
}

export interface UserProfile {
  username: string;
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
