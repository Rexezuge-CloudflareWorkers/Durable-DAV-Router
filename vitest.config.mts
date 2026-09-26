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
    exclude: ['test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['apps/api/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts', '**/types.d.ts', '**/model/**'],
      thresholds: {
        // Enforced floor (measured 29/23/36/30 after hardening; raise toward
        // 50/40/50/50 as coverage grows — never lower to make CI pass).
        statements: 28,
        branches: 23,
        functions: 36,
        lines: 30,
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
