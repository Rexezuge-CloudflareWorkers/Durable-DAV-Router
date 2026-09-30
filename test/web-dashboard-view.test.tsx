// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Assertions read the inline Title-Case defaults, matching the existing SPA
    // component tests, so a missing bundle key fails visibly here rather than
    // rendering a raw key.
    t: (key: string, fallback?: string, vars?: Record<string, string | number>) => {
      let text = fallback ?? key;
      const entries = Object.entries(vars ?? {});
      for (const [k, v] of entries) {
        text = text.replace(`{{${k}}}`, String(v));
      }
      return text;
    },
  }),
}));

const volumeService = vi.hoisted(() => ({
  listMyVolumes: vi.fn(async () => ({ volumes: [] as unknown[], backends: [] as unknown[] })),
}));
const backendService = vi.hoisted(() => ({
  listBackends: vi.fn(async () => [] as unknown[]),
  probeBackend: vi.fn(),
}));

vi.mock('../apps/web/src/services/volumeService', () => volumeService);
vi.mock('../apps/web/src/services/backendService', () => backendService);

import { DashboardView } from '../apps/web/src/views/DashboardView';

/**
A volume shape the dashboard renders a card for.
*/
function volume(name: string): Record<string, unknown> {
  return { owner: 'alice', name, href: `/alice/${name}`, isPrivate: false };
}

function renderDashboard(showNotice = vi.fn()) {
  const utils = render(
    <MemoryRouter>
      <DashboardView showNotice={showNotice} />
    </MemoryRouter>,
  );
  return { ...utils, showNotice };
}

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

describe('DashboardView load races', () => {
  beforeEach(() => {
    volumeService.listMyVolumes.mockReset();
    backendService.listBackends.mockReset();
    backendService.listBackends.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the newest response when two loads overlap out of order', async () => {
    // The dashboard's load effect had no cancellation flag, so whichever
    // `Promise.all` settled *last* won — including a request that had already
    // been superseded. A slow first load resolving after a fast second one
    // leaves the user looking at stale buckets with no spinner, no error, and
    // nothing to tell them the data is out of date.
    //
    // StrictMode is not decoration here: React double-invokes mount effects, so
    // this overlap is the state every developer sees locally, and the same
    // shape occurs in production whenever a slow request overlaps a refresh.
    const first = deferred<{ volumes: unknown[]; backends: unknown[] }>();
    const second = deferred<{ volumes: unknown[]; backends: unknown[] }>();
    volumeService.listMyVolumes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(
      <StrictMode>
        <MemoryRouter>
          <DashboardView showNotice={vi.fn()} />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(volumeService.listMyVolumes).toHaveBeenCalledTimes(2);

    // The newer load answers first...
    await act(async () => {
      second.resolve({ volumes: [volume('fresh')], backends: [] });
      await second.promise;
    });
    await waitFor(() => expect(screen.getByText('fresh')).toBeTruthy());

    // ...and only then does the one it replaced.
    await act(async () => {
      first.resolve({ volumes: [volume('stale')], backends: [] });
      await first.promise;
    });

    expect(screen.getByText('fresh')).toBeTruthy();
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('does not raise an error notice from a view that has unmounted', async () => {
    // React removed the "setState on an unmounted component" warning in 18, so
    // the rest of the effect body keeps running silently after unmount — and
    // `showNotice` writes to a notice bar the user has already navigated away
    // from, which surfaces on the *next* page as an error about this one.
    const pending = deferred<{ volumes: unknown[]; backends: unknown[] }>();
    volumeService.listMyVolumes.mockReturnValueOnce(pending.promise);
    const showNotice = vi.fn();

    const { unmount } = renderDashboard(showNotice);
    unmount();

    await act(async () => {
      pending.reject(new Error('backend list failed'));
      await pending.promise.catch(() => undefined);
    });

    expect(showNotice).not.toHaveBeenCalled();
  });

  it('reports a load failure while mounted', () => {
    // The mirror of the test above: the notice must still fire when the view is
    // actually on screen, or "no notice after unmount" would be satisfiable by
    // simply never notifying at all.
    volumeService.listMyVolumes.mockRejectedValueOnce(new Error('backend list failed'));
    const showNotice = vi.fn();
    renderDashboard(showNotice);
    return waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', expect.any(String)));
  });
});
