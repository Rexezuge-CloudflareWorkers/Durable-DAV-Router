import { defineConfig } from 'vitest/config';
import { cloudflareTest, cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const apiSrcPath = fileURLToPath(new URL('../../apps/api/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('../../packages/backend-data/src', import.meta.url));
const backendRuntimeSrcPath = fileURLToPath(new URL('../../packages/backend-runtime/src', import.meta.url));
const webdavSrcPath = fileURLToPath(new URL('../../packages/webdav/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const backendServicesSrcPath = fileURLToPath(new URL('../../packages/backend-services/src', import.meta.url));

const rexezugeDist = (name: string): string => fileURLToPath(new URL(`../../node_modules/@rexezuge/${name}/dist/index.js`, import.meta.url));

const migrationsDir = path.resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  // Explicit numeric collation: `0001`, `0002`, … must apply in order, and a
  // default string sort is locale-dependent.
  .sort((a, b) => a.localeCompare(b, 'en'));
// Per-file map, not one concatenated blob: a test that seeds data *between*
// migrations (the cascade-wipe regression) needs to stop at a boundary.
const migrationMap: Record<string, string> = Object.fromEntries(
  migrationFiles.map((f) => [f, readFileSync(path.resolve(migrationsDir, f), 'utf8')]),
);

export default defineConfig({
  define: {
    __INTEGRATION_MIGRATIONS__: JSON.stringify(migrationMap),
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './test/integration/wrangler.test.jsonc',
      },
    }),
  ],
  test: {
    globals: true,
    include: ['test/integration/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage-integration',
      include: ['apps/api/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.int.test.ts', '**/*.d.ts', '**/index.ts', '**/types.d.ts'],
    },
    pool: cloudflarePool({
      wrangler: {
        configPath: './test/integration/wrangler.test.jsonc',
      },
    }),
  },
  ssr: {
    noExternal: ['hono', 'chanfana', '@durable-dav-router'],
  },
  resolve: {
    alias: [
      { find: /^@durable-dav-router\/backend-data$/, replacement: `${backendDataSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/backend-runtime$/, replacement: `${backendRuntimeSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/webdav$/, replacement: `${webdavSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/shared$/, replacement: `${sharedSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/backend-services$/, replacement: `${backendServicesSrcPath}/index.ts` },
      { find: '@durable-dav-router/backend-data', replacement: backendDataSrcPath },
      { find: '@durable-dav-router/backend-runtime', replacement: backendRuntimeSrcPath },
      { find: '@durable-dav-router/webdav', replacement: webdavSrcPath },
      { find: '@durable-dav-router/shared', replacement: sharedSrcPath },
      { find: '@durable-dav-router/backend-services', replacement: backendServicesSrcPath },
      // The kit ships bundled dist with bare cross-package imports
      // (`@rexezuge/d1` → `@rexezuge/errors`); the worker bundle must resolve
      // every one or workerd fails the import at runtime.
      { find: /^@rexezuge\/d1$/, replacement: rexezugeDist('d1') },
      { find: /^@rexezuge\/errors$/, replacement: rexezugeDist('errors') },
      { find: /^@rexezuge\/http$/, replacement: rexezugeDist('http') },
      { find: /^@rexezuge\/i18n$/, replacement: rexezugeDist('i18n') },
      { find: /^@rexezuge\/identity$/, replacement: rexezugeDist('identity') },
      { find: /^@rexezuge\/runtime$/, replacement: rexezugeDist('runtime') },
      { find: /^@rexezuge\/shared$/, replacement: rexezugeDist('shared') },
      { find: /^@\//, replacement: `${apiSrcPath}/` },
    ],
  },
});
