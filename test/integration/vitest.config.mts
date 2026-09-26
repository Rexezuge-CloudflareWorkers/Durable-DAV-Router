import { defineConfig } from 'vitest/config';
import { cloudflareTest, cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const apiSrcPath = fileURLToPath(new URL('../../apps/api/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('../../packages/backend-data/src', import.meta.url));
const backendErrorsSrcPath = fileURLToPath(new URL('../../packages/backend-errors/src', import.meta.url));
const backendRuntimeSrcPath = fileURLToPath(new URL('../../packages/backend-runtime/src', import.meta.url));
const webdavSrcPath = fileURLToPath(new URL('../../packages/webdav/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const backendServicesSrcPath = fileURLToPath(new URL('../../packages/backend-services/src', import.meta.url));

const migrationsDir = resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migrationSql = migrationFiles.map((f) => readFileSync(resolve(migrationsDir, f), 'utf-8')).join('\n\n');

export default defineConfig({
  define: {
    __INTEGRATION_MIGRATION_SQL__: JSON.stringify(migrationSql),
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
      { find: /^@durable-dav-router\/backend-errors$/, replacement: `${backendErrorsSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/backend-runtime$/, replacement: `${backendRuntimeSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/webdav$/, replacement: `${webdavSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/shared$/, replacement: `${sharedSrcPath}/index.ts` },
      { find: /^@durable-dav-router\/backend-services$/, replacement: `${backendServicesSrcPath}/index.ts` },
      { find: '@durable-dav-router/backend-data', replacement: backendDataSrcPath },
      { find: '@durable-dav-router/backend-errors', replacement: backendErrorsSrcPath },
      { find: '@durable-dav-router/backend-runtime', replacement: backendRuntimeSrcPath },
      { find: '@durable-dav-router/webdav', replacement: webdavSrcPath },
      { find: '@durable-dav-router/shared', replacement: sharedSrcPath },
      { find: '@durable-dav-router/backend-services', replacement: backendServicesSrcPath },
      { find: /^@\//, replacement: `${apiSrcPath}/` },
    ],
  },
});
