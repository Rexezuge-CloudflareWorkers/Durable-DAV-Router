#!/usr/bin/env node
/**
 * Fail when the SPA shell the API worker serves is missing or self-inconsistent.
 *
 * `DurableDavRouterWorker` answers browser navigations with `SPA_HTML`, embedded
 * from `apps/web/dist/index.html` by the Vite `spa-shell-embed` plugin. Both that
 * file and `apps/web/dist/` are gitignored build artifacts, so a fresh clone
 * gets the empty `postinstall` stub and every `GET /` returns a blank page —
 * with nothing in the source tree saying so.
 *
 * What this catches:
 * - the `postinstall` stub (or no build at all) still in place;
 * - `spa-shell.ts` referencing `/assets/...` bundles that were not emitted (a
 *   partially cleaned or half-copied `dist/`, which serves a shell whose JS
 *   404s and therefore renders no bucket browser at all);
 * - `spa-shell.ts` and `apps/web/dist/index.html` disagreeing, i.e. only one of
 *   the two halves of the build was refreshed;
 * - the built CSS missing the Tailwind utilities the kit's primitives are made
 *   of, which is the failure where every control renders its markup and none
 *   of its styling (see `scripts/spa-shell-checks.ts`).
 *
 * Known limit, deliberately stated rather than papered over: this cannot detect a
 * *stale but self-consistent* pair. A `dist/` and a `spa-shell.ts` built together
 * from last week's source agree with each other, and that is precisely the
 * failure this script was added after — the checked-in bundle was scaffolded
 * from another repository's build and predated every change to
 * `apps/web/src`, so the bucket browser it shipped was missing the fixes in
 * `davXml.ts` and `davClient.ts` entirely. That class is covered at the source
 * level by `test/web-davxml.test.ts` and `test/web-davclient.test.ts`. The
 * remaining duty is operational: run `pnpm run build` after touching `apps/web`,
 * before `wrangler deploy`.
 *
 * The rules live in `scripts/spa-shell-checks.ts` so they can be unit tested;
 * this entrypoint only does I/O and reporting. The import is the `.ts` file
 * because Node ≥ 22.6 strips types, which is how `scripts/validate_locales.ts`
 * is run too.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkCss } from './spa-shell-checks.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SHELL_PATH = join(ROOT, 'apps/api/src/generated/spa-shell.ts');
const DIST_INDEX = join(ROOT, 'apps/web/dist/index.html');
const DIST_ASSETS = join(ROOT, 'apps/web/dist/assets');

/**
 * A built shell is a full Vite `index.html`. The stub is `SPA_HTML: string = ''`.
 * Any threshold works; this one only has to reject an obviously empty value.
 */
const MIN_HTML_BYTES = 200;

const problems = [];

function fail(message) {
  problems.push(message);
}

/** The `SPA_HTML` string literal, decoded from the generated TS module. */
function readEmbeddedHtml() {
  if (!existsSync(SHELL_PATH)) {
    fail('apps/api/src/generated/spa-shell.ts is missing — run `pnpm run build` (only apps/web has a build script).');
    return null;
  }
  const source = readFileSync(SHELL_PATH, 'utf8');
  const marker = 'export const SPA_HTML: string = ';
  const at = source.indexOf(marker);
  if (at === -1) {
    fail('apps/api/src/generated/spa-shell.ts does not export SPA_HTML — regenerate it with `pnpm run build`.');
    return null;
  }
  const literal = source.slice(at + marker.length).replace(/;\s*$/, '');
  // `postinstall` writes `SPA_HTML: string = ''`, which `JSON.parse` rejects, so
  // check it first: the stub is the most common failure (a fresh clone that
  // never ran `pnpm run build`) and deserves the actionable message.
  if (literal === "''" || literal === '""') {
    fail(
      'apps/api/src/generated/spa-shell.ts still holds the empty postinstall stub — run `pnpm run build`. ' +
        'Until then every browser navigation served by the API worker is a blank page.',
    );
    return null;
  }
  let html;
  try {
    html = JSON.parse(literal);
  } catch {
    fail('apps/api/src/generated/spa-shell.ts is not the generated shape — delete it and run `pnpm run build`.');
    return null;
  }
  if (typeof html !== 'string' || html.length < MIN_HTML_BYTES) {
    fail(
      `apps/api/src/generated/spa-shell.ts holds no usable HTML (${String(html).length} chars) — run \`pnpm run build\`. ` +
        'Until then every browser navigation served by the API worker is a blank page.',
    );
    return null;
  }
  return html;
}

/**
 * The built CSS, as one string.
 *
 * Every `.css` file in `dist/assets` is concatenated rather than picking one:
 * a chunked build emits more than one, and a check that only looked at the
 * first would report a kit utility as missing because it landed in the second.
 * `null` means there is no bundle at all, which is a build that did not run.
 */
function readCssBundle(dir) {
  try {
    const cssFiles = readdirSync(dir).filter((file) => file.endsWith('.css'));
    if (cssFiles.length === 0) return null;
    return cssFiles.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
  } catch {
    return null;
  }
}

const html = readEmbeddedHtml();

if (html !== null) {
  // Every same-origin asset the shell references must exist in `dist/assets`.
  // A missing one means the served page loads with no JS, so the bucket browser
  // silently renders nothing at all.
  const referenced = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((m) => m[1]);
  if (referenced.length === 0) {
    fail('The embedded shell references no /assets/ bundles — it is not a real Vite build output.');
  }
  for (const asset of new Set(referenced)) {
    if (!existsSync(join(DIST_ASSETS, asset))) {
      fail(`The embedded shell references /assets/${asset}, which is not in apps/web/dist/assets — run \`pnpm run build\`.`);
    }
  }

  // The plugin writes a verbatim copy of dist/index.html, so a disagreement means
  // only one half of the build was refreshed.
  if (!existsSync(DIST_INDEX)) {
    fail('apps/web/dist/index.html is missing — run `pnpm run build`.');
  } else if (readFileSync(DIST_INDEX, 'utf8') !== html) {
    fail('apps/api/src/generated/spa-shell.ts does not match apps/web/dist/index.html — run `pnpm run build`.');
  }
}

// The SPA shell check cannot see CSS class names (they are hashed in at build
// time, not bundled into the shell), so the kit's utilities are verified here
// from the on-disk bundle rather than from the served HTML.
for (const problem of checkCss(readCssBundle(DIST_ASSETS))) {
  fail(`[${problem.code}] ${problem.detail}`);
}

if (problems.length > 0) {
  console.error('SPA shell check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  'SPA shell check passed (apps/api/src/generated/spa-shell.ts matches apps/web/dist, and the built CSS carries the kit utilities).',
);
