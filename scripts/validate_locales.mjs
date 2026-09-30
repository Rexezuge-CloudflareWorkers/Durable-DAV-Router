#!/usr/bin/env node
/**
 * Validate web locale bundles: JSON-valid, key parity with en (no missing or
 * extra keys), `{{placeholder}}` parity, no empty values, bundle-dir parity with
 * web `SUPPORTED_LANGUAGES` (parsed from `apps/web/src/i18n.ts`, so a
 * listed-but-unshipped language fails here instead of at runtime in
 * `loadLanguage`), and **code↔bundle key coverage in both directions**. Key
 * order drift vs en is warn-only (keeps diffs reviewable without failing the
 * run).
 *
 * The coverage check is the one that catches the failure this script originally
 * could not see. Parity against `en` answers "are these translations
 * consistent?"; it never asks "do the keys exist?". Every `t('…')` call passes
 * an English default as its second argument, so a key missing from `en` renders
 * as that default — correct-looking English, forever, with a translator opening
 * the bundle to find nothing there. And a key in the bundle with no caller looks
 * maintained while being unreachable, so a fix to it can never ship.
 *
 * `test/i18n.test.ts` asserts the same invariants so they run under `pnpm test`;
 * this script is the CI-facing half, which also covers a locale added without
 * its tests.
 *
 * Usage: `pnpm run validate:locales` from the repo root.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
const LOCALES_DIR = join(WEB_SRC, 'locales');
const WEB_I18N_FILE = join(WEB_SRC, 'i18n.ts');
const PLACEHOLDER = /\{\{[^}]+\}\}/g;

/**
 * Namespaces the SPA uses. Anything outside them in a string literal is prose,
 * not a translation key, and must not be mistaken for one.
 */
const KEY_NAMESPACE = '(?:header|common|landing|dashboard|volumes|credentials|files|settings|unauthorized|errors|backends)';

function flatten(node, prefix, out) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out.push([path, value]);
    }
  }
  return out;
}

function placeholdersOf(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value.match(PLACEHOLDER) ?? [])].sort();
}

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`FAIL: ${message}`);
};
const warn = (message) => {
  console.warn(`WARN: ${message}`);
};

let tags;
try {
  tags = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  fail(`cannot list locales dir ${LOCALES_DIR}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (!tags.includes('en')) {
  fail('missing base locale: en/translation.json');
  process.exit(1);
}

// Every tag in web `SUPPORTED_LANGUAGES` (single source of truth:
// `apps/web/src/i18n.ts`) must ship a bundle dir, and vice versa —
// otherwise `loadLanguage` throws at runtime for a listed language.
let supported;
try {
  const i18nSource = readFileSync(WEB_I18N_FILE, 'utf8');
  const match = i18nSource.match(/SUPPORTED_LANGUAGES\s*=\s*\[([^\]]+)\]/);
  supported = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
} catch (error) {
  fail(`cannot read web i18n.ts ${WEB_I18N_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (supported.length === 0) fail('could not parse SUPPORTED_LANGUAGES from web i18n.ts');
for (const tag of supported.filter((tag) => !tags.includes(tag)))
  fail(`missing locale directory for supported language: ${tag}/translation.json`);
for (const tag of tags.filter((tag) => !supported.includes(tag))) fail(`extra locale directory not in SUPPORTED_LANGUAGES: ${tag}`);

const bundles = new Map();
for (const tag of tags) {
  const file = join(LOCALES_DIR, tag, 'translation.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`${tag}: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  try {
    bundles.set(tag, JSON.parse(raw));
  } catch (error) {
    fail(`${tag}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const enEntries = flatten(bundles.get('en') ?? {}, '', []);
const enKeys = enEntries.map(([key]) => key);
const enSet = new Set(enKeys);
const enByKey = new Map(enEntries);
if (enKeys.length === 0) fail('en bundle is empty or unreadable');

/**
 * Keys the SPA asks for, and where each is asked for.
 *
 * Three literal call shapes, all of which have to be recognised or the check
 * reports false coverage:
 *
 *   t('ns.key') / t('ns.key', 'Default')
 *   toLocalizedErrorMessage(t, error, 'ns.key', 'Default')  — the fallback key
 *   BACKEND_TYPE_TO_I18N_KEY's value map                    — resolved at runtime,
 *                                                            so never in a t()
 *
 * A computed key (`t(\`${ns}.${x}\`)`) would need this list maintained by hand;
 * there is none, and `fail` below is what would report it if one appeared.
 */
function referencedKeys() {
  const found = new Map();
  const add = (key, where) => {
    if (!found.has(key)) found.set(key, where);
  };
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) sources.push(full);
    }
  };
  walk(WEB_SRC);
  const patterns = [
    new RegExp(`\\bt\\(\\s*'(${KEY_NAMESPACE}\\.[^']+)'`, 'g'),
    new RegExp(`toLocalizedErrorMessage\\(\\s*\\w+\\s*,\\s*\\w+\\s*,\\s*'(${KEY_NAMESPACE}\\.[^']+)'`, 'g'),
    new RegExp(`:\\s*'(${KEY_NAMESPACE}\\.[^']+)'`, 'g'),
  ];
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) add(match[1], file.replace(`${WEB_SRC}/`, ''));
    }
    // A computed key defeats static extraction; say so rather than pass quietly.
    if (/[^.\w]t\(\s*`/.test(source)) fail(`${file.replace(`${WEB_SRC}/`, '')}: computed t() key — teach this script its shape`);
  }
  return found;
}

const referenced = referencedKeys();
const missingFromBundle = [...referenced.keys()].filter((key) => !enSet.has(key)).sort();
for (const key of missingFromBundle.slice(0, 20)) fail(`no such key in en bundle: ${key} (used by ${referenced.get(key)})`);
if (missingFromBundle.length > 20) fail(`…and ${missingFromBundle.length - 20} more keys used by the SPA but absent from en`);

const unreachable = enKeys.filter((key) => !referenced.has(key)).sort();
for (const key of unreachable.slice(0, 20)) fail(`unreachable bundle key (no caller): ${key}`);
if (unreachable.length > 20) fail(`…and ${unreachable.length - 20} more unreachable bundle keys`);
console.log(`coverage: ${referenced.size} keys referenced, ${missingFromBundle.length} missing, ${unreachable.length} unreachable`);

for (const [tag, bundle] of bundles) {
  if (tag === 'en') continue;
  const entries = flatten(bundle ?? {}, '', []);
  const keys = entries.map(([key]) => key);
  const set = new Set(keys);
  const byKey = new Map(entries);

  for (const key of enKeys.filter((key) => !set.has(key)).slice(0, 10)) fail(`${tag}: missing key ${key}`);
  const missingCount = enKeys.filter((key) => !set.has(key)).length;
  for (const key of keys.filter((key) => !enSet.has(key)).slice(0, 10)) fail(`${tag}: extra key ${key} (no en source)`);
  const extraCount = keys.filter((key) => !enSet.has(key)).length;

  const empty = entries.filter(([, value]) => typeof value !== 'string' || value === '').map(([key]) => key);
  for (const key of empty.slice(0, 10)) fail(`${tag}: empty value at ${key}`);

  const phMismatches = keys.filter((key) => {
    if (!enSet.has(key)) return false;
    const a = placeholdersOf(enByKey.get(key));
    const b = placeholdersOf(byKey.get(key));
    return a.length !== b.length || a.some((ph, i) => ph !== b[i]);
  });
  for (const key of phMismatches.slice(0, 10)) {
    fail(
      `${tag}: placeholder mismatch at ${key} (en=${JSON.stringify(placeholdersOf(enByKey.get(key)))} vs ${tag}=${JSON.stringify(placeholdersOf(byKey.get(key)))})`,
    );
  }

  const orderDrift = keys.length !== enKeys.length || keys.some((key, index) => key !== enKeys[index]);
  if (orderDrift) {
    warn(`${tag}: key order differs from en (warn-only)`);
  }

  const status = missingCount === 0 && extraCount === 0 && empty.length === 0 && phMismatches.length === 0 ? 'OK' : 'FAIL';
  console.log(
    `${tag}: keys=${keys.length} missing=${missingCount} extra=${extraCount} empty=${empty.length} ph_mismatch=${phMismatches.length} [${status}]`,
  );
}

console.log(failed ? 'FAILURES PRESENT' : 'ALL OK');
process.exit(failed ? 1 : 0);
