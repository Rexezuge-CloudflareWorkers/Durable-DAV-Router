import { LocaleUtil } from '@rexezuge/shared';

type SupportedLanguageTag = ReturnType<typeof LocaleUtil.normalize>;

/**
 * The places a language preference can come from, in precedence order. Each is
 * `null`/`undefined` when unavailable. No backend source here: the router's
 * `/user/me` returns only `{email, id}`, so the choice is held locally.
 */
interface LanguageSources {
  /**
   * `localStorage('durable-dav-router-lng')` — or the client-cached
   * `user.preferredLanguage`, which mirrors it after a change.
   */
  stored?: string | null;
  /**
   * `navigator.language`.
   */
  navigatorLanguage?: string | null;
}

/**
 * Picks the language: stored choice > browser > `en`.
 *
 * The first source that is **present** wins and is then normalised — so an
 * unsupported stored value falls to `en` rather than to the browser. That is
 * deliberate: the stored value is the user's own choice, and silently replacing
 * it with whatever the browser reports would flip the UI on the next load.
 *
 * Kept free of i18next and Vite imports so the precedence is testable from the
 * root suite, the same shape as the rest of `lib/`.
 */
function resolvePreferredLanguage(sources: LanguageSources): SupportedLanguageTag {
  const chosen = [sources.stored, sources.navigatorLanguage].find((value) => typeof value === 'string' && value !== '');
  return LocaleUtil.normalize(chosen);
}

export type { LanguageSources };
export { resolvePreferredLanguage };
