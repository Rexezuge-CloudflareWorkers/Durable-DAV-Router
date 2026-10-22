/**
 * The rules the SPA shell check enforces, as pure functions.
 *
 * They live here so they can be unit tested; `scripts/verify-spa-shell.mjs` is
 * the entrypoint that does the I/O and the reporting.
 *
 * TypeScript rather than `.mjs` because `test/scripts/spa-shell-checks.test.ts`
 * imports these rules directly, and Node runs both it and the entrypoint
 * directly (Node ≥ 22.6 strips types).
 */

/**
 * One thing wrong with the built SPA, in a form the entrypoint can print.
 *
 * `code` is a stable identifier so a failure can be recognised by a human or a
 * CI annotation, and `detail` is the sentence that says what to do about it.
 */
export interface ShellProblem {
  readonly code: 'missing-css' | 'missing-tailwind-utility';
  readonly detail: string;
}

/**
 * The Tailwind utilities the SPA cannot ship without, one per reported symptom
 * so a failure names something a reader can see on screen.
 *
 * Every one of them is emitted **only** by a kit primitive this SPA adopts —
 * `ModalShell` and `ConfirmDeleteModal` (`inset-0`, `bg-black/60`, `shadow-2xl`,
 * `rounded-2xl`, `w-80`, `z-50`, `border-[var(--color-border-muted)]`),
 * `NoticeBar` (`sr-only`, `-translate-x-1/2`, `left-1/2`,
 * `max-w-[calc(100vw-2rem)]`) and `Unauthorized`
 * (`focus-visible:outline-[var(--color-accent)]`). The kit's markup is plain
 * Tailwind utility strings, and Tailwind v4 scans only the Vite project root,
 * which excludes `node_modules` — so without the `@source` line for the kit in
 * `apps/web/src/globals.css` these are never generated. What the user sees is a
 * modal backdrop that does not cover the viewport, a notice banner that is not
 * centred, and a sign-in button with no focus outline.
 *
 * **Every token here must appear nowhere under `apps/web/`.** Tailwind's scan
 * root is the Vite root, so it reads *Markdown as readily as JSX* — a class
 * name written in this repository's own prose is a class name the scanner
 * finds, and Tailwind emits it whether or not the kit is a source. That is not
 * a hypothetical: a Markdown sentence naming two of these tokens was enough to
 * make both appear in the built CSS **with the `@source` line deleted**, which
 * is exactly how a gate like this one stops measuring the thing it exists to
 * measure. `test/scripts/spa-shell-checks.test.ts` walks the scan root and
 * fails if any token is written there, so the next person to document a
 * utility finds out from the suite rather than from a gate that has quietly
 * stopped measuring.
 *
 * Matched as class *selectors* — see `checkCss`.
 */
export const KIT_REQUIRED_CSS_TOKENS: readonly string[] = [
  'inset-0',
  'bg-black/60',
  'shadow-2xl',
  'rounded-2xl',
  'w-80',
  'z-50',
  'border-[var(--color-border-muted)]',
  'sr-only',
  '-translate-x-1/2',
  'left-1/2',
  'max-w-[calc(100vw-2rem)]',
  'focus-visible:outline-[var(--color-accent)]',
];

/**
 * The problems with the built CSS bundle.
 *
 * `css` is the bundle text, or `null` when no bundle exists. A missing bundle is
 * a build that did not run; a bundle missing one of the kit tokens means
 * `globals.css` lost its `@source` line, so only half the kit is styled.
 *
 * Each token is matched as a class **selector**, never as a bare substring. A
 * bare match is satisfied by the theme variable of the same name — Tailwind
 * emits `--animate-spin:spin 1s linear infinite` from its default theme whether
 * or not anything uses it — so a substring check would call a missing utility
 * present. The leading `.` is what a generated utility always has and a custom
 * property never has. Backslashes are stripped from both sides first, so the
 * escape form (`.bg-\[var\(--color-accent\)\]`) and the plain token agree.
 *
 * The remediation message names the *file* and the *package*, never the path.
 * Quoting the `@source` line verbatim would leave the operator being told to
 * restore text that no longer existed anywhere in the repository the moment that
 * line's form changed. A gate that reports the wrong fix is worse than no gate:
 * it gets acted on.
 */
export function checkCss(css: string | null): ShellProblem[] {
  if (css === null) {
    return [
      {
        code: 'missing-css',
        detail: 'No CSS bundle found in apps/web/dist/assets — run `pnpm run build`.',
      },
    ];
  }
  const selectors = css.replaceAll('\\', '');
  const missing = KIT_REQUIRED_CSS_TOKENS.filter((token) => !selectors.includes(`.${token.replaceAll('\\', '')}`));
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      code: 'missing-tailwind-utility',
      detail:
        'The built CSS is missing the kit primitive utilities ' +
        missing.map((token) => `\`${token}\``).join(', ') +
        ' — these only compile when ' +
        'the `@source` line for `@rexezuge/web` in `apps/web/src/globals.css` is present. Without it every shared control ships without styling. ' +
        'Run `pnpm run build` after restoring the line.',
    },
  ];
}
