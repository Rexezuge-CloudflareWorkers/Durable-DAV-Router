// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RouterBackend } from '../apps/web/src/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Assertions read the inline Title-Case defaults, matching the other SPA
    // component tests, so a missing bundle key fails visibly here rather than
    // rendering a raw key.
    t: (key: string, fallback?: string, vars?: Record<string, string | number>) => {
      let text = fallback ?? key;
      const substitutions = Object.entries(vars ?? {});
      for (const [name, value] of substitutions) text = text.replace(`{{${name}}}`, String(value));
      return text;
    },
  }),
}));

const backendService = vi.hoisted(() => ({
  listBackends: vi.fn(async () => [] as unknown[]),
  updateBackend: vi.fn(),
  deleteBackend: vi.fn(),
  probeBackend: vi.fn(),
}));

vi.mock('../apps/web/src/services/backendService', () => backendService);

import { BackendsSettingsCard } from '../apps/web/src/components/settings/BackendsSettingsCard';

/**
 * A registered backend.
 *
 * `lastStatus`/`lastSeenAt` are the liveness fields this card now reports, and
 * they are epoch *seconds* (`BackendService.recordProbe` writes
 * `getCurrentUnixTimestampInSeconds`), so a fixture in milliseconds would render
 * a date in 1970 and make a units mistake look like a formatting one.
 */
function backend(overrides: Partial<RouterBackend> = {}): RouterBackend {
  return {
    slug: 'office',
    baseUrl: 'https://dav.example.com',
    displayName: 'Office',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    lastSeenAt: null,
    lastStatus: null,
    ...overrides,
  };
}

const probe = {
  slug: 'office',
  baseUrl: 'https://dav.example.com',
  health: { status: 200, error: null },
  volumes: { status: 200, error: null },
};

/**
 * Renders the card with a route table, so the `/backends/new` link and the
 * navigation it performs are both real rather than asserted on the handler.
 */
function renderCard(showNotice = vi.fn(), initialPath = '/') {
  const utils = render(
    <MemoryRouter initialEntries={[initialPath]}>
      <BackendsSettingsCard showNotice={showNotice} />
      <Routes>
        <Route path="/backends/new" element={<div>new backend form</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, showNotice };
}

describe('BackendsSettingsCard', () => {
  beforeEach(() => {
    backendService.listBackends.mockReset();
    backendService.listBackends.mockResolvedValue([backend()]);
    backendService.probeBackend.mockReset();
    backendService.probeBackend.mockResolvedValue(probe);
    backendService.deleteBackend.mockReset();
    backendService.deleteBackend.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('reports a backend that has never been probed as such', async () => {
    // Not `● unknown`. A backend the router has never reached is a materially
    // different fact from one it reached and could not understand, and the
    // collapsed form is what the dashboard used to print.
    renderCard();
    expect(await screen.findByText('● Never Probed')).toBeTruthy();
  });

  it('reports the last recorded status and when it was seen', async () => {
    backendService.listBackends.mockResolvedValue([backend({ lastStatus: 502, lastSeenAt: 1_700_000_000 })]);
    renderCard();
    const status = await screen.findByText(/● 502/);
    expect(status.textContent).toContain('Last Seen');
    // The rendered year is the assertion that the epoch-seconds field was
    // multiplied by 1000 rather than read as milliseconds — read raw, the same
    // number renders as January 1970 and still *looks* like a date.
    expect(status.textContent).toContain(String(new Date(1_700_000_000 * 1000).getFullYear()));
  });

  it('offers a Check on every row, not only on a backend that looks broken', async () => {
    // The dashboard showed Check only when the `/user/volumes` fan-out reported
    // a failure. That signal came from the fan-out, and this card does not make
    // the request — so gating on it would hide the only way to get a fresh
    // answer about a backend this page claims is fine.
    backendService.listBackends.mockResolvedValue([backend({ lastStatus: 200, lastSeenAt: 1_700_000_000 })]);
    renderCard();
    await screen.findByText(/● 200/);
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
  });

  it('re-reads the list after a probe so the row shows the fresh status', async () => {
    // `/user/backends/:slug/probe` writes `last_status`/`last_seen_at` through
    // `recordProbe`. Without the re-read the notice reports a new answer while
    // the row underneath keeps the old one — and a status assertion on the
    // notice alone cannot see that.
    backendService.listBackends.mockResolvedValue([backend({ lastStatus: 502 })]);
    const { showNotice } = renderCard();
    await screen.findByText(/● 502/);
    expect(backendService.listBackends).toHaveBeenCalledTimes(1);

    backendService.listBackends.mockResolvedValue([backend({ lastStatus: 200, lastSeenAt: 1_700_000_000 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    await waitFor(() => expect(screen.getByText(/● 200/)).toBeTruthy());
    expect(backendService.probeBackend).toHaveBeenCalledWith('office');
    expect(backendService.listBackends).toHaveBeenCalledTimes(2);
    expect(showNotice).toHaveBeenCalledWith('success', expect.stringContaining('Probe office'));
  });

  it('reports a failed probe as an error and keeps the row', async () => {
    backendService.probeBackend.mockRejectedValue(new Error('gateway timeout'));
    const { showNotice } = renderCard();
    await screen.findByText('● Never Probed');
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', expect.any(String)));
    expect(screen.getByText('Office (office)')).toBeTruthy();
  });

  it('does not unregister a backend until the confirmation is accepted', async () => {
    // One click used to delete the registration outright. Nothing else in the
    // registry does that — bucket deletion goes through a type-to-confirm — and
    // a mis-click here costs the owner handle cache the WebDAV route keys on.
    renderCard();
    await screen.findByText('Office (office)');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(backendService.deleteBackend).not.toHaveBeenCalled();

    // Scoped to the dialog: the row's own Delete is still mounted underneath,
    // and clicking *that* one is the mis-click this confirmation exists for.
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(backendService.deleteBackend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(backendService.deleteBackend).toHaveBeenCalledWith('office'));
  });

  it('names the backend in the confirmation', async () => {
    // Two backends in a list, one Delete each: the dialog has to say which one,
    // or confirming the wrong row's is indistinguishable from the right one.
    backendService.listBackends.mockResolvedValue([backend(), backend({ slug: 'home', displayName: 'Home', baseUrl: 'https://home.example.com' })]);
    renderCard();
    await screen.findByText('Home (home)');
    const [firstDelete] = screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(firstDelete);
    expect(screen.getByText(/Delete Office \(office\)\?/)).toBeTruthy();
    expect(screen.queryByText(/Delete Home \(home\)\?/)).toBeNull();
  });

  it('adds a backend from the registry, which is now its only home', async () => {
    // The dashboard's Add Backend button moved here with the rest of the
    // section, so this is the only entry point to `/backends/new` in the SPA.
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Backend' }));
    expect(await screen.findByText('new backend form')).toBeTruthy();
  });

  it('says so when the registry is empty rather than rendering nothing', async () => {
    backendService.listBackends.mockResolvedValue([]);
    renderCard();
    expect(await screen.findByText('No Backends Registered.')).toBeTruthy();
  });
});