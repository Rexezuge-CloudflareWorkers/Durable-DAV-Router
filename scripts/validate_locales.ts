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
 * TypeScript rather than `.mjs` because it shares the key extractor with
 * `test/i18n.test.ts`, and Node runs it directly (Node ≥ 22.6 strips types).
 * Two implementations of that extractor drift, and a key that has drifted out of
 * one is reported as reachable while the other reports it as an orphan.
 *
 * Usage: `pnpm run validate:locales` from the repo root.
 */
import fs from 'node:fs';
const { readdirSync, readFileSync } = fs;
import path from 'node:path';
const { dirname, join } = path;
import { fileURLToPath } from 'node:url';
import { computedKeySites, referencedKeys } from './i18n-coverage.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
const LOCALES_DIR = join(WEB_SRC, 'locales');
const WEB_I18N_FILE = join(WEB_SRC, 'i18n.ts');
const PLACEHOLDER = /\{\{[^}]+\}\}/g;

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

// The extractor lives in `i18n-coverage.mjs` because `test/i18n.test.ts` asserts
// the same two invariants. Two copies of a namespace list drift, and a key that
// has drifted out of one is reported as reachable while the other reports it as
// an orphan.
const referenced = referencedKeys(WEB_SRC);
for (const site of computedKeySites(WEB_SRC)) fail(`${site}: computed t() key — teach i18n-coverage.mjs its shape`);
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
