// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { useAsyncLoad } from '../apps/web/src/hooks/useAsyncLoad';
import { useBusyAction } from '../apps/web/src/hooks/useBusyAction';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

/**
 * `useAsyncLoad` is the guard six call sites used to hand-roll, and one of them
 * was missing it — which is why it is tested as a hook rather than through a
 * consumer. Everything here is a cancellation or a staleness property, none of
 * which a component test can reach without arranging the same overlap.
 */
describe('useAsyncLoad', () => {
  function Probe({ load, onError, reloadKey }: { load: () => Promise<string>; onError?: (e: unknown) => void; reloadKey?: string }) {
    const { data, loading, reload, patch } = useAsyncLoad(load, { onError, reloadKey });
    return (
      <div>
        <span data-testid="value">{data ?? 'none'}</span>
        <span data-testid="loading">{loading ? 'yes' : 'no'}</span>
        <button onClick={reload}>reload</button>
        <button
          onClick={() => {
            patch((current) => `${current}!`);
          }}
        >
          patch
        </button>
      </div>
    );
  }

  it('delivers the loaded value and clears loading', async () => {
    render(<Probe load={async () => 'hello'} />);
    expect(screen.getByTestId('loading').textContent).toBe('yes');
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('hello'));
    expect(screen.getByTestId('loading').textContent).toBe('no');
  });

  it('keeps the newest of two overlapping loads', async () => {
    // The `DashboardView` bug. StrictMode double-invokes mount effects, so this
    // overlap is every dev mount; a refresh overlapping a slow request is the
    // production equivalent. Whichever settles *last* used to win.
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(
      <StrictMode>
        <Probe load={load} />
      </StrictMode>,
    );
    expect(load).toHaveBeenCalledTimes(2);

    second.resolve('newer');
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('newer'));

    first.resolve('older');
    await first.promise;
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('newer'));
    expect(screen.getByTestId('loading').textContent).toBe('no');
  });

  it('does not report the error of a superseded load', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const onError = vi.fn();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(
      <StrictMode>
        <Probe load={load} onError={onError} />
      </StrictMode>,
    );
    second.resolve('newer');
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('newer'));
    first.reject(new Error('stale failure'));
    await first.promise.catch(() => undefined);
    await Promise.resolve();
    // The superseded request's failure is not the user-visible one.
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not call onError after unmount', async () => {
    const pending = deferred<string>();
    const onError = vi.fn();
    const { unmount } = render(<Probe load={() => pending.promise} onError={onError} />);
    unmount();
    pending.reject(new Error('too late'));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failure while mounted, and keeps the previous value', async () => {
    let attempt = 0;
    const onError = vi.fn();
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      return 'second';
    });
    render(<Probe load={load} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    // A failed load must not blank what the user is already reading; only the
    // explicit reload below replaces it.
    expect(screen.getByTestId('value').textContent).toBe('none');
    expect(screen.getByTestId('loading').textContent).toBe('no');
  });

  it('re-runs on reload without the caller changing anything', async () => {
    const load = vi.fn(async () => String(load.mock.calls.length));
    render(<Probe load={load} />);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('1'));
    act(() => {
      screen.getByRole('button', { name: 'reload' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('2'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('re-runs when the caller composes a new key', async () => {
    // The bucket browser's identity is the load: change owner or backend and the
    // value has to be re-read, without anyone pressing refresh.
    const load = vi.fn(async () => 'x');
    function Keyed({ owner }: { owner: string }) {
      return <Probe load={load} reloadKey={owner} />;
    }
    const { rerender } = render(<Keyed owner="alice" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender(<Keyed owner="bob" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('does not re-run when the loader identity changes but the key does not', async () => {
    // Every caller's loader closes over props, so it is a fresh function on every
    // render. Treating that as a dependency re-fires the request on every render
    // — which, in a component whose render is triggered by the request, is an
    // infinite loop. This is the reason the hook reads its loader as an effect
    // event rather than as a dependency.
    let tick = 0;
    const loadSpy = vi.fn(async () => {
      tick += 1;
      return `run-${tick}`;
    });
    function Outer() {
      const [, force] = useState(0);
      return (
        <div>
          <button onClick={() => force((n) => n + 1)}>tick</button>
          <Probe load={loadSpy} />
        </div>
      );
    }
    render(<Outer />);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('run-1'));
    act(() => {
      screen.getByRole('button', { name: 'tick' }).click();
    });
    await Promise.resolve();
    expect(loadSpy).toHaveBeenCalledOnce();
  });

  it('patches in place for optimistic UI, and no-ops before anything is loaded', async () => {
    const load = vi.fn(async () => 'base');
    render(<Probe load={load} />);
    // Before the load settles there is nothing to patch, and silently inventing
    // a value would render a row the server never sent.
    act(() => {
      screen.getByRole('button', { name: 'patch' }).click();
    });
    expect(screen.getByTestId('value').textContent).toBe('none');
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('base'));
    act(() => {
      screen.getByRole('button', { name: 'patch' }).click();
    });
    expect(screen.getByTestId('value').textContent).toBe('base!');
  });
});

describe('useBusyAction', () => {
  function Actions({ onRejected }: { onRejected?: (error: unknown) => void }) {
    const { busy, run } = useBusyAction();
    return (
      <div>
        <span data-testid="busy">{busy ? 'yes' : 'no'}</span>
        <button
          onClick={() => {
            void run(async () => {
              await Promise.resolve();
            });
          }}
        >
          ok
        </button>
        {/* `run` propagates the rejection by design: it clears `busy` on the way
            out and leaves the *reporting* to the caller, which is the only layer
            that knows the message to show. A caller that forgets therefore gets an
            unhandled rejection — loud, rather than a silent no-op. */}
        <button
          onClick={() => {
            void run(async () => {
              throw new Error('nope');
            }).catch(onRejected ?? (() => undefined));
          }}
        >
          fail
        </button>
      </div>
    );
  }

  it('is busy for the whole of an action and not after it', async () => {
    render(<Actions />);
    expect(screen.getByTestId('busy').textContent).toBe('no');
    act(() => {
      screen.getByRole('button', { name: 'ok' }).click();
    });
    expect(screen.getByTestId('busy').textContent).toBe('yes');
    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('no'));
  });

  it('clears busy when the action throws, and still surfaces the error', async () => {
    // The failure mode this hook exists for: a mutation that forgets its
    // `finally` leaves every button in the bucket browser disabled until the next
    // page load, with no error shown. Clearing `busy` and propagating are separate
    // concerns — the caller owns the message, the hook owns the flag.
    const onRejected = vi.fn();
    render(<Actions onRejected={onRejected} />);
    act(() => {
      screen.getByRole('button', { name: 'fail' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('no'));
    expect(onRejected).toHaveBeenCalledOnce();
  });

  it("returns the action's value, and a failure yields undefined", async () => {
    // The contract callers rely on: `await run(...)` is the whole mutation, and
    // its return is what a caller would branch on.
    const results: Array<string | undefined> = [];
    function Typed() {
      const { run } = useBusyAction();
      return (
        <div>
          <button
            onClick={() => {
              void run(async () => 'done').then((value: string | undefined) => results.push(value));
            }}
          >
            typed
          </button>
        </div>
      );
    }
    render(<Typed />);
    act(() => {
      screen.getByRole('button', { name: 'typed' }).click();
    });
    await waitFor(() => expect(results).toEqual(['done']));
  });
});
