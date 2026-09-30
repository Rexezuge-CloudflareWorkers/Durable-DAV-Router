import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiSrcPath = fileURLToPath(new URL('apps/api/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('packages/backend-data/src', import.meta.url));
const backendErrorsSrcPath = fileURLToPath(new URL('packages/backend-errors/src', import.meta.url));
const backendRuntimeSrcPath = fileURLToPath(new URL('packages/backend-runtime/src', import.meta.url));
const webdavSrcPath = fileURLToPath(new URL('packages/webdav/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('packages/shared/src', import.meta.url));
const backendServicesSrcPath = fileURLToPath(new URL('packages/backend-services/src', import.meta.url));

/**
 * The SPA's test and coverage gate.
 *
 * Split from `vitest.config.mts` — which covers the worker and the packages — for
 * the reason that config's header sets out: one number could not honestly describe
 * both halves. The worker and the packages are logic with real failure modes and
 * measured in the 90s before this SPA existed; adding 44 presentational modules at
 * 0% pulled the shared floor down by 16 points, leaving the worker roughly a point
 * of headroom. So a change adding legitimate code in `apps/api` could fail the gate
 * on the strength of files two directories away.
 *
 * Two config files rather than Vitest `projects` in one: with a single config the
 * SPA suites ran under `node` and the worker suites under `jsdom` in the same pass,
 * which is how a test could pass in one environment and fail in the other without
 * either run noticing. `pnpm run test` and `pnpm run test:coverage` run both, and
 * both gates are enforced.
 */

/**
 * Every alias, mirroring `vitest.config.mts`.
 *
 * Duplicated rather than imported because a Vitest config is a standalone file with
 * no module graph to share through, and a suite that resolves a workspace import
 * differently from its sibling fails in a way that looks like a product bug.
 */
const alias = [
  { find: /^@durable-dav-router\/backend-data$/, replacement: `${backendDataSrcPath}/index.ts` },
  { find: /^@durable-dav-router\/backend-errors$/, replacement: `${backendErrorsSrcPath}/index.ts` },
  { find: /^@durable-dav-router\/backend-runtime$/, replacement: `${backendRuntimeSrcPath}/index.ts` },
  { find: /^@durable-dav-router\/backend-services$/, replacement: `${backendServicesSrcPath}/index.ts` },
  { find: /^@durable-dav-router\/webdav$/, replacement: `${webdavSrcPath}/index.ts` },
  { find: /^@durable-dav-router\/shared$/, replacement: `${sharedSrcPath}/index.ts` },
  { find: '@durable-dav-router/backend-data', replacement: backendDataSrcPath },
  { find: '@durable-dav-router/backend-errors', replacement: backendErrorsSrcPath },
  { find: '@durable-dav-router/backend-runtime', replacement: backendRuntimeSrcPath },
  { find: '@durable-dav-router/backend-services', replacement: backendServicesSrcPath },
  { find: '@durable-dav-router/webdav', replacement: webdavSrcPath },
  { find: '@durable-dav-router/shared', replacement: sharedSrcPath },
  { find: /^@\//, replacement: `${apiSrcPath}/` },
];

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    // jsdom for every file here, rather than a `@vitest-environment` pragma per
    // file: these are the tests that need a DOM, and the pragma is one more place
    // to forget.
    environment: 'jsdom',
    // Every SPA suite is named `web-*`. `vitest.config.mts` excludes the same glob
    // from its own run, so the two partition the suite rather than duplicating it.
    include: ['test/**/web-*.test.{ts,tsx}'],
    // Threads, bounded, rather than one forked worker per file. Each jsdom document
    // is a whole browser environment; a fork per file is the shape that exhausts
    // memory on a constrained machine, and when it does the run dies partway with a
    // bare "Worker exited unexpectedly" and no test ever reports a failure — which
    // reads as a flaky suite rather than as an out-of-memory kill. Threads share one
    // process, so the cost is paid once.
    pool: 'threads',

    // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
    // re-listed: `test` is a workspace project and therefore has its own.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      // Without this the v8 provider reports only modules a test happened to
      // import, so a brand-new component with no test is invisible rather than
      // counted as zero — which would make this gate unable to notice the exact
      // regression it exists to catch. Verified: an untouched component
      // (`ConfirmDeleteModal`) is reported at 0%, not omitted.
      all: true,
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage-spa',
      include: ['apps/web/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/types.ts'],
      // Measured 55.75 / 52.26 / 54.11 / 56.45. Up from 45.00 / 46.07 / 42.72 /
      // 45.22 at the start of this change, and from 38.7% lines before it — the two
      // hooks that replaced eleven hand-rolled copies of a cancellation flag, plus
      // suites for the notice timer, the identity gate, the mutation hook and the
      // shared UI primitives.
      //
      // Note what is being measured. Before `all: true`, the v8 provider reported
      // only modules a test happened to import, and this same tree read 83% — the 44
      // modules with no test were simply absent from the denominator. A gate that
      // cannot see an untested component is not a gate; `ConfirmDeleteModal` is at
      // 0% here and that is the truth. The remaining ~44 points are the other
      // presentational modules, and the next ratchet is those.
      //
      // Set just under the measurement, because a floor that a legitimate change can
      // trip is a floor that gets lowered rather than met — and lowering one is the
      // one thing `AGENTS.md` forbids.
      thresholds: { statements: 55, branches: 52, functions: 54, lines: 56 },
    },
  },
});