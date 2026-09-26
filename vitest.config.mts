import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiSrcPath = fileURLToPath(new URL('apps/api/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('packages/backend-data/src', import.meta.url));
const backendErrorsSrcPath = fileURLToPath(new URL('packages/backend-errors/src', import.meta.url));
const backendRuntimeSrcPath = fileURLToPath(new URL('packages/backend-runtime/src', import.meta.url));
const webdavSrcPath = fileURLToPath(new URL('packages/webdav/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('packages/shared/src', import.meta.url));
const backendServicesSrcPath = fileURLToPath(new URL('packages/backend-services/src', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
    // re-listed: `test` is a workspace project and therefore has its own. Without
    // this, `test/**/*.test.ts` reaches into `test/node_modules` and tries to run
    // other packages' own suites (which import `bun:test` and `@jest/globals`).
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      // `apps/web` was previously absent from this list, on a comment claiming
      // it was "measured by its own config in `apps/web`". No such config ever
      // existed — `apps/web` has no vitest config and no `test` script — so the
      // entire SPA, including the bucket browser's href parser and its request
      // URL builder, was invisible to the coverage gate. It is measured here now.
      include: ['apps/api/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'packages/**/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/index.ts',
        '**/types.d.ts',
        '**/model/**',
        // Generated at build time from the Vite bundle: a one-line HTML blob
        // with no logic to exercise.
        'apps/api/src/generated/**',
        // Type-only modules: no runtime code to cover.
        '**/D1Types.ts',
        '**/ServiceEnv.ts',
        '**/env.d.ts',
        // Re-export barrels carry no logic of their own.
        '**/dao/identity.ts',
        '**/dao/router.ts',
      ],
      thresholds: {
        // `apps/web` joined `include` in this change, and it is the whole reason
        // the floor moved. The previous 80/75/80/80 was measured against
        // `apps/api` + `packages` only; the SPA sat outside the gate entirely
        // (on a comment claiming a config in `apps/web` that never existed), so
        // that number was never a statement about this repository as a whole.
        //
        // What is measured and covered today: `apps/web/src/lib` (94%) and
        // `apps/web/src/services` (94%) — the href parser, the request-URL
        // builder, and every API wrapper including the `?backend=` selector
        // that four files each implement differently. That is the logic with
        // real failure modes, and it is where the bug this change fixes lived.
        //
        // What is measured but uncovered: 44 presentational modules under
        // `components/` and the `views/` tree, at 0%. They need jsdom,
        // testing-library and react-router harnesses. They are listed rather
        // than excluded so the gap is visible in the report instead of hidden.
        //
        // This floor is the honest measurement of the surface now in `include`,
        // set slightly below it. Raise it as the SPA gains tests. Never lower
        // it to excuse a regression in code that is already covered.
        //
        // Follow-up: split the SPA into its own Vitest project with its own
        // floor, so component tests can ratchet up independently instead of
        // moving a global number shared with the worker and the packages.
        statements: 64,
        branches: 62,
        functions: 63,
        lines: 65,
      },
    },
  },
  resolve: {
    alias: [
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
    ],
  },
});
