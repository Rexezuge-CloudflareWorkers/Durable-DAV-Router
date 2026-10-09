/**
 * Which i18n keys does the SPA actually ask for?
 *
 * Shared by `validate_locales.mjs` (the CI-facing check) and `test/i18n.test.ts`
 * (the unit check), because two copies of a namespace list drift — and a key that
 * has drifted out of one is reported as reachable while the other reports it as
 * an orphan, which is worse than having no check at all.
 *
 * Three literal call shapes, all of which have to be recognised or the check
 * reports false coverage:
 *
 *   t('ns.key') / t('ns.key', 'Default')
 *   toLocalizedErrorMessage(t, error, 'ns.key', 'Default')  — the fallback key
 *   `someMap: { nsKey: 'ns.key' }`                          — resolved at runtime,
 *                                                            so never in a t()
 *
 * The third shape is a heuristic — any `key: 'ns.something'` literal counts — so
 * it can over-approximate. That is the safe direction: a key wrongly counted as
 * referenced is invisible, while one wrongly counted as an orphan fails the build
 * and is looked at.
 *
 * A computed key (`t(\`${ns}.${x}\`)`) would defeat this entirely. There is none,
 * and `computedKeySites` reports one so it cannot be added unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';

const { readdirSync, readFileSync } = fs;
const { join } = path;

/**
 * Namespaces the SPA uses. Anything outside them in a string literal is prose, not
 * a translation key, and must not be mistaken for one.
 */
export const KEY_NAMESPACES = [
  'header',
  'common',
  'landing',
  'dashboard',
  'volumes',
  'credentials',
  'files',
  'settings',
  'unauthorized',
  'errors',
  'backends',
  'replication',
];

const NS = `(?:${KEY_NAMESPACES.join('|')})`;

const PATTERNS: RegExp[] = [
  // t('ns.key')
  new RegExp(`\\bt\\(\\s*'(${NS}\\.[^']+)'`, 'g'),
  // toLocalizedErrorMessage(t, error, 'ns.key', 'Default')
  new RegExp(`toLocalizedErrorMessage\\(\\s*\\w+\\s*,\\s*\\w+\\s*,\\s*'(${NS}\\.[^']+)'`, 'g'),
  // A map value: `BACKEND_TYPE_TO_I18N_KEY`, a `change({ doneKey: 'ns.key' })`, …
  new RegExp(`:\\s*'(${NS}\\.[^']+)'`, 'g'),
];

/** Files under `webSrc`, recursively, that could contain a key. */
export function webSources(webSrc: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(webSrc);
  return out;
}

/**
 * Every referenced key, mapped to the first file that asks for it.
 */
export function referencedKeys(webSrc: string): Map<string, string> {
  const found = new Map<string, string>();
  const add = (key: string, where: string): void => {
    if (!found.has(key)) found.set(key, where.replace(`${webSrc}/`, ''));
  };
  for (const file of webSources(webSrc)) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      for (const match of source.matchAll(pattern)) add(match[1], file);
    }
  }
  return found;
}

/** Files whose `t()` key is computed rather than literal, and so invisible here. */
export function computedKeySites(webSrc: string): string[] {
  const sites: string[] = [];
  for (const file of webSources(webSrc)) {
    const source = readFileSync(file, 'utf8');
    if (/[^.\w]t\(\s*`/.test(source)) sites.push(file.replace(`${webSrc}/`, ''));
  }
  return sites;
}