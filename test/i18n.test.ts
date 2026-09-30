import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
// The extractor is shared with `scripts/validate_locales.ts`. Two copies of the
// namespace list drifted once already during this work, reporting the same key as
// reachable in one place and as an orphan in the other.
import { computedKeySites, referencedKeys } from '../scripts/i18n-coverage.js';
import {
  BACKEND_STRINGS,
  SUPPORTED_BACKEND_LOCALES,
  canonicalizeBackendLocaleTag,
  formatBackendString,
  getBackendStrings,
  normalizeBackendLocale,
  resolveLocalizedStrings,
} from '@durable-dav-router/shared/i18n';

// NOTE: `apps/web/src/i18n.ts` is not importable in this node unit-test env —
// it pulls `i18next`/`react-i18next` (web-only deps, not resolvable from the repo
// root) and a Vite `import.meta.glob` locale chunk map. Web-side
// `normalizeLanguage`/`detectInitialLanguage` are therefore covered by
// `pnpm run validate:locales` (key parity of all bundles + bundle-dir parity
// with `SUPPORTED_LANGUAGES`, plus code-to-bundle key coverage) and by the
// `web locale key coverage` suite below for the pure helpers that have no
// web-only dependency.

describe('backend strings (en)', () => {
  it('serves Title Case English strings', () => {
    const strings = getBackendStrings('en');
    expect(strings).toBe(BACKEND_STRINGS.en);
    expect(strings.common.unauthorized).toBe('Authentication Required.');
    expect(strings.common.forbidden).toBe('Access Denied.');
    expect(strings.common.internalError).toBe('Internal Server Error.');
  });

  it('exposes only the namespaces the router actually returns', () => {
    // The router has no repos, tokens, issues, or namespaces. Those namespaces
    // came from the Durable-DAV backend and were unreachable here.
    for (const locale of SUPPORTED_BACKEND_LOCALES) {
      expect(Object.keys(BACKEND_STRINGS[locale])).toEqual(['common']);
    }
  });

  it('keeps locale bundles structurally identical', () => {
    const enKeys = Object.keys(BACKEND_STRINGS.en).sort();
    expect(SUPPORTED_BACKEND_LOCALES).toEqual(['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'ja', 'zh-CN', 'zh-TW', 'ko']);
    expect(Object.keys(BACKEND_STRINGS)).toEqual([...SUPPORTED_BACKEND_LOCALES]);
    for (const locale of SUPPORTED_BACKEND_LOCALES) {
      expect(Object.keys(BACKEND_STRINGS[locale]).sort()).toEqual(enKeys);
      expect(Object.keys(BACKEND_STRINGS[locale].common).sort()).toEqual(Object.keys(BACKEND_STRINGS.en.common).sort());
    }
  });

  it('gives every locale a non-empty translation for every key', () => {
    // A missing or blank string would surface to a client as an empty `Message`.
    for (const locale of SUPPORTED_BACKEND_LOCALES) {
      const entries = Object.entries(BACKEND_STRINGS[locale].common);
      for (const [key, value] of entries) {
        expect(typeof value, `${locale}:${key}`).toBe('string');
        expect(value.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps {placeholder} parity across all locales', () => {
    const varsOf = (value: string): string[] => [...new Set(value.match(/\{\w+\}/g) || [])].sort();
    const collect = (node: object, out: Map<string, string[]>): void => {
      for (const [key, value] of Object.entries(node)) {
        if (value !== null && typeof value === 'object') collect(value as object, out);
        else if (typeof value === 'string') out.set(key, varsOf(value));
      }
    };
    const enVars = new Map<string, string[]>();
    collect(BACKEND_STRINGS.en, enVars);
    for (const locale of SUPPORTED_BACKEND_LOCALES) {
      if (locale === 'en') continue;
      const vars = new Map<string, string[]>();
      collect(BACKEND_STRINGS[locale], vars);
      for (const [key, expected] of enVars) {
        expect(vars.get(key), `${locale}:${key}`).toEqual(expected);
      }
    }
  });

  it('actually localizes rather than echoing English everywhere', () => {
    // Guards against a bundle silently falling back to the English text.
    expect(getBackendStrings('ja').common.internalError).not.toBe(BACKEND_STRINGS.en.common.internalError);
    expect(getBackendStrings('de').common.unauthorized).not.toBe(BACKEND_STRINGS.en.common.unauthorized);
  });
});

describe('backend strings (zh-CN)', () => {
  it('serves Chinese strings', () => {
    const strings = getBackendStrings('zh-CN');
    expect(strings.common.internalError).toBe('服务器内部错误。');
    expect(strings.common.internalError).not.toBe(BACKEND_STRINGS.en.common.internalError);
  });
});

describe('locale fallback', () => {
  it('falls back to en for unknown, empty, or missing locales', () => {
    for (const locale of ['en-US', 'xx', '', null, undefined]) {
      expect(getBackendStrings(locale)).toBe(BACKEND_STRINGS.en);
    }
  });

  it('serves every supported locale directly', () => {
    for (const locale of SUPPORTED_BACKEND_LOCALES) {
      expect(getBackendStrings(locale)).toBe(BACKEND_STRINGS[locale]);
    }
  });

  it('maps zh variants to zh-CN', () => {
    for (const locale of ['zh', 'zh_CN', 'ZH-cn']) {
      expect(getBackendStrings(locale)).toBe(BACKEND_STRINGS['zh-CN']);
    }
  });

  it('base-matches regional variants to their language bundle', () => {
    expect(getBackendStrings('de-AT')).toBe(BACKEND_STRINGS.de);
    expect(getBackendStrings('fr-CA')).toBe(BACKEND_STRINGS.fr);
    expect(getBackendStrings('pt-BR')).toBe(BACKEND_STRINGS.pt);
  });

  it('canonicalizes tags case- and separator-insensitively', () => {
    expect(canonicalizeBackendLocaleTag('zh_cn')).toBe('zh-CN');
    expect(canonicalizeBackendLocaleTag('ZH-CN')).toBe('zh-CN');
    expect(canonicalizeBackendLocaleTag(' en ')).toBe('en');
    expect(normalizeBackendLocale('pt')).toBe('pt');
    expect(normalizeBackendLocale('xx')).toBe('en');
  });

  it('resolveLocalizedStrings prefers the primary locale, then the fallback', () => {
    expect(resolveLocalizedStrings('zh-CN')).toBe(BACKEND_STRINGS['zh-CN']);
    expect(resolveLocalizedStrings('xx', 'zh-CN')).toBe(BACKEND_STRINGS['zh-CN']);
    expect(resolveLocalizedStrings('de', 'zh-CN')).toBe(BACKEND_STRINGS.de);
    expect(resolveLocalizedStrings(null, null)).toBe(BACKEND_STRINGS.en);
    expect(resolveLocalizedStrings('en')).toBe(BACKEND_STRINGS.en);
  });
});

describe('formatBackendString', () => {
  it('substitutes string and number placeholders', () => {
    expect(formatBackendString('Repository {fullName} Created.', { fullName: 'alice/demo' })).toBe('Repository alice/demo Created.');
    expect(formatBackendString('Maximum Of {max} Tokens Reached.', { max: 5 })).toBe('Maximum Of 5 Tokens Reached.');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(formatBackendString('Hello {name}.', {})).toBe('Hello {name}.');
    expect(formatBackendString('No vars here.')).toBe('No vars here.');
  });

  it('ignores non-scalar variable values', () => {
    // A substituted `[object Object]` would reach a client verbatim.
    expect(formatBackendString('Value: {v}', { v: {} as unknown as string })).toBe('Value: {v}');
  });
});

/**
 * Web locale key coverage, in both directions.
 *
 * `validate_locales.mjs` compared every bundle against `en`, which answers "are
 * the translations consistent?" and never "do the keys exist?" — so a `t('…')`
 * naming a key absent from `en` passed every check and silently rendered
 * i18next's own fallback. Every such call site passes an English default as its
 * second argument, which is precisely why it is invisible: the UI looks correct,
 * in English, forever, and the only evidence is that a translator opens the
 * bundle and finds nothing there.
 *
 * A key in the bundle with no caller is the mirror problem — a translation that
 * looks maintained but is unreachable, so a fix to it can never ship.
 */
describe('web locale key coverage', () => {
  const WEB_SRC = path.join(import.meta.dirname, '..', 'apps', 'web', 'src');

  /**
  Every leaf in the bundle as a dotted key.
  */
  function flatten(node: Record<string, unknown>, prefix = '', out: [string, unknown][] = []): [string, unknown][] {
    const entries = Object.entries(node);
    for (const [key, value] of entries) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) flatten(value as Record<string, unknown>, dotted, out);
      else out.push([dotted, value]);
    }
    return out;
  }

  const enBundle = JSON.parse(readFileSync(path.join(WEB_SRC, 'locales', 'en', 'translation.json'), 'utf8')) as Record<string, unknown>;
  const referenced = referencedKeys(WEB_SRC);
  const bundleKeys = new Set(flatten(enBundle).map(([key]) => key));

  it('resolves every key the SPA asks for', () => {
    // A missing key renders i18next's raw key path in production, not the English
    // default: the second argument to `t()` is a *default value*, honoured only
    // when `returnEmptyString` and the key are both absent from the resource —
    // which is a runtime detail no type system checks and no status-code test
    // sees. Assert the resource exists.
    const unresolved = [...referenced].filter(([key]) => !bundleKeys.has(key)).map(([key, where]) => `${key} (${where})`);
    expect(unresolved).toEqual([]);
  });

  it('has no unreachable keys in the bundle', () => {
    const orphans = [...bundleKeys].filter((key) => !referenced.has(key)).sort();
    expect(orphans).toEqual([]);
  });

  it('has no computed t() keys, which no static check can see', () => {
    // `t(\`${ns}.${x}\`)` would make every key in the bundle unreferenceable by
    // this check and every missing key undetectable, silently. There is none; a
    // new one has to be reported rather than quietly disable the coverage.
    expect(computedKeySites(WEB_SRC)).toEqual([]);
  });

  it('ships the same keys in every locale directory', () => {
    const localesDir = path.join(WEB_SRC, 'locales');
    const tags = readdirSync(localesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(tags).toContain('en');
    for (const tag of tags) {
      const other = JSON.parse(readFileSync(path.join(localesDir, tag, 'translation.json'), 'utf8')) as Record<string, unknown>;
      expect({ tag, keys: flatten(other).map(([key]) => key).sort() }).toEqual({ tag, keys: [...bundleKeys].sort() });
    }
  });
});
