import { describe, expect, it, vi } from 'vitest';
import {
  Container,
  providerOf,
  memoizeAsync,
  setRequestScope,
  getRequestScope,
  asScopedContext,
  SCOPE_KEY,
} from '@durable-dav-router/backend-runtime/di';
import type { Token } from '@durable-dav-router/backend-runtime/di';

const A = Symbol('A') as Token<{ name: string }>;
const B = Symbol('B') as Token<number>;

describe('Container', () => {
  it('builds from a factory and memoizes it', async () => {
    // One scope per request is the whole point: a second `get` must not build a
    // second instance, or a request would open two D1-backed objects.
    const factory = vi.fn(() => ({ name: 'value' }));
    const container = new Container().bind(A, factory);
    expect(container.get(A)).toBe(container.get(A));
    expect(factory).toHaveBeenCalledOnce();
  });

  it('passes itself to the factory so bindings can depend on each other', () => {
    const container = new Container();
    container.bind(A, (c) => ({ name: `id-${String(c.get(B))}` }));
    container.bindValue(B, 7);
    expect(container.get(A).name).toBe('id-7');
  });

  it('prefers a bound value over a factory for the same token', () => {
    const container = new Container();
    container.bind(B, () => 1);
    container.bindValue(B, 2);
    expect(container.get(B)).toBe(2);
  });

  it('throws a named error for an unbound token', () => {
    // The token name is what makes a wiring mistake diagnosable in production.
    expect(() => new Container().get(A)).toThrow(/no binding for token/);
  });

  it('reports whether a token is bound', () => {
    const container = new Container().bindValue(B, 1);
    expect(container.has(B)).toBe(true);
    expect(container.has(A)).toBe(false);
  });

  it('rebuilds on every resolve, for genuinely request-scoped objects', async () => {
    const factory = vi.fn(() => ({ name: 'x' }));
    const container = new Container().bind(A, factory);
    container.get(A);
    container.get(A);
    expect(factory).toHaveBeenCalledTimes(1);
    container.resolve(A);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('falls back to the memoized instance when only a value is bound', () => {
    const container = new Container().bindValue(B, 5);
    expect(container.resolve(B)).toBe(5);
  });

  it('refuses use after dispose', () => {
    // Disposing releases memoized singletons; a late `get` must fail loudly
    // rather than return a torn-down object.
    const container = new Container().bindValue(B, 1);
    container.dispose();
    expect(() => container.get(B)).toThrow(/disposed/);
    expect(() => container.bind(B, () => 1)).toThrow(/disposed/);
  });

  it('inherits bindings into a child without sharing instances', () => {
    const parent = new Container().bind(A, () => ({ name: 'parent' }));
    const child = parent.createChild();
    expect(child.get(A).name).toBe('parent');
    // The child gets its own memo table, so resolving there does not populate
    // the parent's.
    parent.dispose();
    expect(child.get(A).name).toBe('parent');
  });

  it('rejects binds before any resolution when disposed', () => {
    const container = new Container();
    container.dispose();
    expect(() => container.bindValue(B, 1)).toThrow(/disposed/);
  });
});

describe('providerOf', () => {
  it('lifts an already-built value into a promise-returning provider', async () => {
    // This is how a test substitutes a fake DAO without a module mock.
    const fake = { name: 'fake' };
    expect(await providerOf(fake)()).toBe(fake);
  });

  it('resolves to undefined for a falsy value rather than throwing', async () => {
    expect(await providerOf(null)()).toBeNull();
  });
});

describe('memoizeAsync', () => {
  it('runs the factory once for concurrent callers', async () => {
    // Two DAOs resolved in the same request must share one instance.
    const factory = vi.fn(async () => ({ id: 1 }));
    const memo = memoizeAsync(factory);
    const [a, b] = await Promise.all([memo(), memo()]);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('does not cache a rejection, so a transient failure is retried', async () => {
    // Caching a failure would poison the whole request scope: one D1 blip would
    // fail every later call in that request.
    let attempts = 0;
    const memo = memoizeAsync(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return { ok: true };
    });
    await expect(memo()).rejects.toThrow('transient');
    await expect(memo()).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });
});

describe('request scope', () => {
  it('round-trips a scope through a context-like object', () => {
    const store = new Map<string, unknown>();
    const ctx = {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      env: {},
    };
    const container = new Container().bindValue(B, 3);
    setRequestScope(asScopedContext(ctx), container);
    expect(getRequestScope(asScopedContext(ctx))).toBe(container);
    expect(getRequestScope(asScopedContext(ctx)).get(B)).toBe(3);
  });

  it('fails with an actionable message when the middleware did not run', () => {
    // "Request scope is not set" tells the reader which middleware to register;
    // a bare undefined would surface as a confusing TypeError downstream.
    const ctx = { get: () => undefined, set: () => undefined, env: {} };
    expect(() => getRequestScope(asScopedContext(ctx))).toThrow(/scopeMiddleware/);
  });

  it('stores under a project-namespaced key, not a bare name', () => {
    // A collision with a host application would silently return the wrong scope.
    expect(SCOPE_KEY).toBe('__durableDavRouterScope');
    expect(SCOPE_KEY).not.toBe('scope');
  });

  it('adapts a context whose get/set overloads do not structurally match', () => {
    // This is the one place the `c as never` cast is allowed to live.
    const honoLike = { get: (): string => '', set: (): void => undefined, env: {} };
    expect(() => asScopedContext(honoLike as never)).not.toThrow();
  });
});
