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
 * The worker-and-packages test and coverage gate.
 *
 * The SPA has its own, in `vitest.web.config.mts`, and the reason is in that
 * file's header. The short version: adding 44 presentational modules at 0% pulled a
 * single shared floor down by 16 points, leaving the worker roughly a point of
 * headroom, so a change adding legitimate code in `apps/api` could fail the gate on
 * the strength of files two directories away. Two floors let each ratchet
 * independently, and both only go up — `AGENTS.md` forbids lowering one.
 *
 * Two config files rather than Vitest `projects` in one: with a single config the
 * SPA suites ran under `node` and the worker suites under `jsdom` in the same pass,
 * so a test could pass in one environment and fail in the other with neither run
 * noticing. `pnpm run test` and `pnpm run test:coverage` run both, and both gates
 * are enforced.
 */

/**
 * Every alias, mirroring `vitest.web.config.mts`.
 *
 * Duplicated rather than imported because a Vitest config is a standalone file with
 * no module graph to share through, and a suite resolving a workspace import
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

/**
 * The SPA's suites, excluded here so the two configs partition the suite rather
 * than each running all of it. Every SPA suite is named `web-*`.
 */
const SPA_FILES = 'test/**/web-*.test.{ts,tsx}';

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
    // re-listed: `test` is a workspace project and therefore has its own. Without
    // it, `test/**/*.test.ts` reaches into `test/node_modules` and tries to run other
    // packages' own suites. The SPA glob is here for the partition, not for coverage.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**', SPA_FILES],
    coverage: {
      provider: 'v8',
      // Without this the v8 provider reports only modules a test happened to import,
      // so a brand-new module with no test is invisible rather than counted as zero
      // — which would make this gate unable to notice the exact regression it exists
      // to catch.
      all: true,
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['apps/api/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: [
        // Build and test tooling, not product source: `scripts/` grows with project
        // surface rather than with complexity, and the god-file guard excludes it for
        // the same reason.
        'scripts/**',
        '**/*.test.ts',
        '**/*.d.ts',
        '**/index.ts',
        '**/types.d.ts',
        '**/model/**',
        // Generated at build time from the Vite bundle: a one-line HTML blob with no
        // logic to exercise.
        'apps/api/src/generated/**',
        // Type-only modules: no runtime code to cover.
        '**/D1Types.ts',
        '**/ServiceEnv.ts',
        '**/env.d.ts',
        // Re-export barrels carry no logic of their own.
        '**/dao/identity.ts',
        '**/dao/router.ts',
      ],
      // Measured 89.72 / 82.06 / 89.79 / 92.22 on this commit.
      thresholds: { statements: 88, branches: 80, functions: 88, lines: 91 },
    },
  },
});