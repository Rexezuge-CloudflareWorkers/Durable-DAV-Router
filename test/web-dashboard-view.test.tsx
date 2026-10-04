// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

// No `backendService` mock: the dashboard's Backends section moved to
// `/settings`, so this view no longer reaches for the registry at all. A mock
// left here would keep passing while the page quietly re-added the request the
// move exists to stop making.
vi.mock('../apps/web/src/services/volumeService', () => volumeService);

import { DashboardView } from '../apps/web/src/views/DashboardView';

/**
A volume row the dashboard renders.

The dashboard links `v.fullName` and groups rows by `v.backend`, so both must be
present for a row to appear at all — a partial fixture renders an empty list and
the assertion below fails for the wrong reason.
*/
function volume(name: string): Record<string, unknown> {
  return { owner: 'alice', name, fullName: `alice/${name}`, href: `/alice/${name}`, isPrivate: false, backend: 'office' };
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
    volumeService.listMyVolumes.mockResolvedValue({ volumes: [], backends: [] });
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
    //
    // The resolutions are deliberately *not* wrapped in `act`: React's act scope
    // waits on every thenable the effects under it started, and one of these
    // promises is still in flight by design. `waitFor` drives the assertion
    // instead, which is the same mechanism React state updates go through here.
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
    second.resolve({ volumes: [volume('fresh')], backends: [] });
    await waitFor(() => expect(screen.getByText('alice/fresh')).toBeTruthy());

    // ...and only then does the one it replaced.
    first.resolve({ volumes: [volume('stale')], backends: [] });
    await first.promise;
    await waitFor(() => expect(screen.getByText('alice/fresh')).toBeTruthy());

    expect(screen.queryByText('alice/stale')).toBeNull();
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

    pending.reject(new Error('backend list failed'));
    await expect(pending.promise).rejects.toThrow('backend list failed');
    // One turn of the microtask queue, which is where the effect's `catch`
    // would have called `showNotice`.
    await Promise.resolve();

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

  it('loads the buckets and nothing else', async () => {
    // One request. The dashboard used to `Promise.all` the volume fan-out with
    // `listBackends`, and every reload spent a second round trip to paint a
    // registry it no longer owns. A page that silently grows the request back is
    // invisible in a status assertion, so this counts the calls.
    renderDashboard();
    await waitFor(() => expect(volumeService.listMyVolumes).toHaveBeenCalledTimes(1));
  });

  it('links the empty buckets state at the backend registry', async () => {
    // With the registry moved to `/settings`, a first-run user has no buckets
    // *and* no backends. This is the only remaining path from the dashboard to
    // registering one.
    renderDashboard();
    const link = await screen.findByRole('link', { name: 'Manage Backends' });
    expect(link.getAttribute('href')).toBe('/settings');
  });

  it('renders no backend registry', async () => {
    // The mirror of the test above. The dashboard carries Connect and Buckets
    // only, so the section's own affordances must be gone from it — a lingering
    // "Add Backend" would mean two registries again.
    volumeService.listMyVolumes.mockResolvedValue({ volumes: [volume('alice-files')], backends: [] });
    renderDashboard();
    await screen.findByText('alice/alice-files');
    expect(screen.queryByRole('button', { name: 'Add Backend' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
  });
});
