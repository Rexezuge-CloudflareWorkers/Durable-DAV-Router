import { canonicalizeLanguageTag } from '../utils/LanguageTag';

const SUPPORTED_BACKEND_LOCALES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'ja', 'zh-CN', 'zh-TW', 'ko'] as const;

type SupportedBackendLocale = (typeof SUPPORTED_BACKEND_LOCALES)[number];

/**
 * Localized messages the router returns to clients.
 *
 * The router has no repos, tokens, issues, or namespaces — those namespaces
 * were carried over from the Durable-DAV backend and were never reachable
 * from this codebase. `internalError` is the only string a request path
 * actually reads (`BaseRoute.toErrorResponse`); `unauthorized` and `forbidden`
 * are wired next to it and are reachable, so they are kept.
 */
interface CommonStrings {
  unauthorized: string;
  forbidden: string;
  internalError: string;
}

interface BackendLocaleStrings {
  common: CommonStrings;
}

function formatBackendString(template: string, vars: Record<string, string | number> = {}): string {
  return template.replaceAll(/\{(\w+)\}/g, (match: string, key: string): string => {
    const value: unknown = vars[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : match;
  });
}

function canonicalizeBackendLocaleTag(tag: string): string {
  return canonicalizeLanguageTag(tag);
}

function normalizeBackendLocale(locale: string | null | undefined): SupportedBackendLocale {
  if (!locale || typeof locale !== 'string') return 'en';
  const canonical = canonicalizeBackendLocaleTag(locale);
  if ((SUPPORTED_BACKEND_LOCALES as readonly string[]).includes(canonical)) {
    return canonical as SupportedBackendLocale;
  }
  const base = canonical.split('-', 1)[0]?.toLowerCase() ?? 'en';
  if (base === 'zh') return 'zh-CN';
  const match = (SUPPORTED_BACKEND_LOCALES as readonly string[]).find((l) => l.toLowerCase() === base);
  return (match || 'en') as SupportedBackendLocale;
}

export type { BackendLocaleStrings, CommonStrings, SupportedBackendLocale };
export { SUPPORTED_BACKEND_LOCALES, canonicalizeBackendLocaleTag, formatBackendString, normalizeBackendLocale };
