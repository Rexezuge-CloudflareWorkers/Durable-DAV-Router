import { describe, expect, it } from 'vitest';
import { clampPage, clampPageSize, hasNextPage, pageCountFor } from '../apps/web/src/lib/davPage';

/**
 * `?page=` and `?limit=` are user-supplied, so the clamps are the trust
 * boundary, not defensive decoration. These assert they hold for the shapes a
 * hand-edited URL can produce.
 *
 * The same arithmetic is enforced server-side in Durable-DAV
 * (`packages/dav-store/src/listing.ts`). It is duplicated here rather than
 * imported because the router reaches a backend over HTTP and links to no
 * server source, so these cases are the only local proof the client's copy
 * behaves.
 */
describe('page size clamping', () => {
  it('accepts the offered sizes unchanged', () => {
    for (const size of [50, 100, 250]) {
      expect(clampPageSize(size)).toBe(size);
    }
  });

  it('caps a size above the ceiling', () => {
    // A page is fully hydrated server-side, so an unbounded `?limit=` would
    // reproduce the whole listing — the exact cost paging exists to avoid.
    expect(clampPageSize(100_000)).toBe(250);
    expect(clampPageSize(Number.MAX_SAFE_INTEGER)).toBe(250);
  });

  it('accepts a small size unchanged, since a small page is a real request', () => {
    // Rounding *up* to a UI-shaped default would answer a different question
    // than the one asked.
    expect(clampPageSize(1)).toBe(1);
    expect(clampPageSize(5)).toBe(5);
  });

  it('falls back to the default for a non-positive size', () => {
    expect(clampPageSize(0)).toBe(100);
    expect(clampPageSize(-50)).toBe(100);
  });

  it('falls back to the default for non-numeric input', () => {
    for (const value of [NaN, Infinity, -Infinity, null, undefined, {}, []]) {
      expect(clampPageSize(value)).toBe(100);
    }
  });

  it('truncates a fraction so a float cannot reach a SQL LIMIT binding', () => {
    expect(clampPageSize(10.9)).toBe(10);
    expect(clampPageSize(100.9)).toBe(100);
  });

  it('parses a numeric string, as a query value arrives', () => {
    expect(clampPageSize('100')).toBe(100);
    expect(clampPageSize('250')).toBe(250);
    expect(clampPageSize('abc')).toBe(100);
  });
});

describe('page number clamping', () => {
  it('reads a valid page', () => {
    expect(clampPage('3')).toBe(3);
  });

  it('treats a missing or blank page as page 1', () => {
    // `?page=` with an empty value is a real case: these URLs are built by code
    // that omits empty params, and a strict parse would render an empty page 1.
    expect(clampPage(null)).toBe(1);
    expect(clampPage('')).toBe(1);
    expect(clampPage(' '.repeat(3))).toBe(1);
  });

  it('floors zero and negatives to page 1', () => {
    expect(clampPage('0')).toBe(1);
    expect(clampPage('-4')).toBe(1);
  });

  it('falls back to page 1 for non-numeric input', () => {
    expect(clampPage('abc')).toBe(1);
    expect(clampPage('NaN')).toBe(1);
  });

  it('truncates a fraction', () => {
    expect(clampPage('3.9')).toBe(3);
  });
});

describe('page count', () => {
  it('counts pages with a ceiling division', () => {
    expect(pageCountFor(100, 100)).toBe(1);
    expect(pageCountFor(101, 100)).toBe(2);
    expect(pageCountFor(250, 100)).toBe(3);
    expect(pageCountFor(0, 100)).toBe(1);
  });
});

describe('next-page availability', () => {
  it('disables Next on the last page', () => {
    expect(hasNextPage(1, 1)).toBe(false);
    expect(hasNextPage(2, 2)).toBe(false);
  });

  it('enables Next when a later page exists', () => {
    expect(hasNextPage(1, 2)).toBe(true);
    expect(hasNextPage(2, 3)).toBe(true);
  });
});
