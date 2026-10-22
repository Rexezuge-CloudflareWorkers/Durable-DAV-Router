import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCss, KIT_REQUIRED_CSS_TOKENS } from '../../scripts/spa-shell-checks';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every file Tailwind's automatic source detection can read for the SPA.
 *
 * Its scan root is the Vite root, `apps/web`, and it reads any text file there
 * *except* what `.gitignore` excludes — so Markdown and config files are
 * candidates alongside JSX, and `node_modules` and `dist` are not. Walking this
 * set is what makes "this token can only come from the kit" a checked
 * statement rather than a claim.
 */
function readAppWeb(): Array<{ file: string; text: string }> {
  const skip = new Set(['node_modules', 'dist']);
  const found: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push({ file: path.relative(REPO_ROOT, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(REPO_ROOT, 'apps/web'));
  return found;
}

describe('checkCss', () => {
  /**
   * A bundle that really carries every token, in Tailwind's emitted selector form.
   */
  const fullBundle = () => KIT_REQUIRED_CSS_TOKENS.map((token) => `.${token}{color:red}`).join('\n');

  it('passes when every kit utility is present as a selector', () => {
    expect(checkCss(fullBundle())).toHaveLength(0);
  });

  it('reads a token out of the Tailwind escape form', () => {
    // What Vite actually writes for an arbitrary-value utility: the brackets, the
    // parens and the var() are all backslash-escaped inside the selector. Neither may
    // be reported as missing, or the gate would fail on a correct build.
    const bundle = String.raw`.inset-0{inset:0}.border-\[var\(--color-border-muted\)\]{border-color:var(--color-border-muted)}`;
    const detail = checkCss(bundle)[0]?.detail ?? '';
    expect(detail).not.toContain('inset-0');
    expect(detail).not.toContain('border-[var(--color-border-muted)]');
  });

  it('does not accept a theme variable in place of a utility', () => {
    // The bug this guards: a theme variable of the same name is not the utility.
    // This app's own `@theme` block declares custom properties that Tailwind
    // emits whatever uses them, so a bare substring match would call a missing
    // utility present. Only a `.`-prefixed selector counts.
    const problems = checkCss(':root{--shadow-2xl:0 25px 50px -12px rgb(0 0 0 / 0.25)}');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('shadow-2xl');
  });

  it('reports the missing token names', () => {
    const omitted = KIT_REQUIRED_CSS_TOKENS[0];
    const css = KIT_REQUIRED_CSS_TOKENS.filter((token) => token !== omitted)
      .map((token) => `.${token}{color:red}`)
      .join('\n');
    const problems = checkCss(css);
    expect(problems.map((problem) => problem.code)).toEqual(['missing-tailwind-utility']);
    expect(problems[0]?.detail).toContain(omitted);
    expect(problems[0]?.detail).toContain('@source');
  });

  it('names a missing bundle `missing-css`', () => {
    expect(checkCss(null).map((problem) => problem.code)).toEqual(['missing-css']);
  });

  it('has no token this repository itself writes into the scan root', () => {
    // Tailwind's scan root is `apps/web/**` and it reads Markdown as readily as
    // JSX, so a token named anywhere under there is compiled into the bundle
    // whether or not the kit is a source — and this gate would pass with the
    // `@source` line deleted. That is not hypothetical: a Markdown sentence in
    // `apps/web/AGENTS.md` naming two of these tokens was enough to make both
    // appear in the built CSS with the `@source` line removed. A doc edit must
    // not be able to disarm the gate silently.
    const files = readAppWeb();
    const offenders = KIT_REQUIRED_CSS_TOKENS.filter((token) => files.some(({ text }) => text.includes(token)));
    expect(offenders).toEqual([]);
  });
});
