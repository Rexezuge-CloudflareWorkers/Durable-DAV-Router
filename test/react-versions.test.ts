import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * React and ReactDOM are one runtime: react-dom throws at startup when the
 * installed versions differ. Dependabot bumps the two packages in separate
 * PRs, so a partial bump can otherwise pass CI's build and fail every web
 * suite at import time. Check both the manifests and what pnpm installed.
 */

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifests = ['package.json', 'apps/web/package.json', 'test/package.json'];


describe('React runtime versions', () => {
  it('pins react and react-dom to the same version in every manifest', () => {
    for (const manifest of manifests) {
      type Manifest = {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const pkg = JSON.parse(readFileSync(path.resolve(repoRoot, manifest), 'utf8')) as Manifest;
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

      expect(dependencies['react-dom'], manifest).toBe(dependencies['react']);
    }
  });

  it('installs matching react and react-dom versions', () => {
    const react = require('react') as { version: string };
    const reactDom = require('react-dom') as { version: string };

    expect(reactDom.version).toBe(react.version);
  });
});
