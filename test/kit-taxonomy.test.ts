import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ServiceError } from '@rexezuge/errors';
import { toServiceError } from '@rexezuge/http';

/**
 * The kit's error taxonomy is one class tree, not two.
 *
 * The kit identifies its errors with `instanceof`, and this repository narrows
 * on that taxonomy at its own boundary:
 * `packages/backend-services/src/errors/ErrorMapper.ts` asks
 * `error instanceof ServiceError`, and `toServiceError` — the function that
 * normalises anything thrown inside the kit — comes from `@rexezuge/http`.
 *
 * That only works if `@rexezuge/http` and this repository share **one** copy of
 * `@rexezuge/errors`. Two copies are two separate module instances, so two
 * separate `ServiceError` classes, and an error thrown inside the kit is not an
 * instance of *this* repository's `ServiceError`: the mapper falls through to
 * the masked 500 instead of the error's own status, and the failure names no
 * package. The tree carried both 1.2.0 and 1.9.0 until `pnpm-workspace.yaml`
 * pinned every kit package to one version.
 *
 * The two assertions below check the property from both ends — the resolved
 * file, and the behaviour — because either alone is satisfiable by accident.
 */

const require = createRequire(import.meta.url);

describe('the kit error taxonomy', () => {
  it('resolves to one file, whichever package asks for it', () => {
    // What this repository's code imports.
    const repoErrors = require.resolve('@rexezuge/errors');
    // What `@rexezuge/http` imports — resolved from the kit's own directory,
    // which is where a second copy would have been installed.
    const kitErrors = createRequire(require.resolve('@rexezuge/http')).resolve('@rexezuge/errors');

    expect(kitErrors).toBe(repoErrors);
  });

  it('recognises a kit-normalised error as one of ours', () => {
    const normalized = toServiceError(new Error('boom'));

    expect(normalized).toBeInstanceOf(ServiceError);
    // The status the mapper would have used, had the taxonomy split.
    expect(normalized.status).toBe(500);
  });
});
