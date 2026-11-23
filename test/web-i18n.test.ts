import { describe, expect, it } from 'vitest';
import { resolvePreferredLanguage } from '../apps/web/src/lib/language';

describe('resolvePreferredLanguage', () => {
  it('prefers the stored choice over the browser', () => {
    expect(resolvePreferredLanguage({ stored: 'de', navigatorLanguage: 'ja' })).toBe('de');
  });

  it('falls back through browser to English', () => {
    expect(resolvePreferredLanguage({ navigatorLanguage: 'fr-CA' })).toBe('fr');
    expect(resolvePreferredLanguage({})).toBe('en');
  });

  it('normalizes regional and underscore variants', () => {
    expect(resolvePreferredLanguage({ stored: 'zh_TW' })).toBe('zh-TW');
    expect(resolvePreferredLanguage({ stored: 'pt-BR' })).toBe('pt');
    expect(resolvePreferredLanguage({ stored: 'EN_us' })).toBe('en');
  });

  it('treats an empty stored value as absent rather than as a chosen language', () => {
    expect(resolvePreferredLanguage({ stored: '', navigatorLanguage: 'ko' })).toBe('ko');
  });

  it('does not fall through when a present choice is unsupported', () => {
    // An unsupported value is the user's own choice: replacing it with the
    // browser's language would flip the UI when the profile loads.
    expect(resolvePreferredLanguage({ stored: 'xx', navigatorLanguage: 'ja' })).toBe('en');
  });
});
