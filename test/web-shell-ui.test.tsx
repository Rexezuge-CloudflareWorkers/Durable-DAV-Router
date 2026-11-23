// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, string | number>) => {
      let text = fallback ?? key;
      const substitutions = Object.entries(vars ?? {});
      for (const [name, value] of substitutions) text = text.replace(`{{${name}}}`, String(value));
      return text;
    },
  }),
}));

const volumeService = vi.hoisted(() => ({
  listMyVolumes: vi.fn(),
}));
const backendService = vi.hoisted(() => ({
  listBackends: vi.fn(async () => [] as unknown[]),
  getBackendIdentity: vi.fn(async () => ({ username: 'alice' })),
}));

vi.mock('../apps/web/src/services/volumeService', () => volumeService);
vi.mock('../apps/web/src/services/backendService', () => backendService);

import { Header } from '../apps/web/src/components/layout/Header';
import { DashboardView } from '../apps/web/src/views/DashboardView';
import { NewVolumeView } from '../apps/web/src/views/NewVolumeView';
import { ModalShell, ModalHeader, ModalBody } from '../apps/web/src/components/modals/ModalShell';

function volume(name: string, overrides: Record<string, unknown> = {}) {
  return { owner: 'alice', name, fullName: `alice/${name}`, href: `/alice/${name}`, isPrivate: false, backend: 'office', ...overrides };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('shell header', () => {
  it('renders the primary navigation as links and marks the current page', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Header userEmail="alice@example.com" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'New' }).getAttribute('href')).toBe('/new');
  });

  it('offers no navigation to a signed-out visitor, only sign-in', () => {
    render(
      <MemoryRouter>
        <Header userEmail={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign In With Cloudflare Access' })).toBeTruthy();
  });
});

describe('dashboard search', () => {
  it('filters the one loaded response without another request', async () => {
    volumeService.listMyVolumes.mockResolvedValue({
      volumes: [volume('photos'), volume('reports', { backend: 'home' })],
      backends: [],
    });
    render(
      <MemoryRouter>
        <DashboardView showNotice={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByText('alice/photos');
    expect(screen.getByText('alice/reports')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Buckets…' }), { target: { value: 'reports' } });

    expect(screen.queryByText('alice/photos')).toBeNull();
    expect(screen.getByText('alice/reports')).toBeTruthy();
    expect(volumeService.listMyVolumes).toHaveBeenCalledTimes(1);
  });
});

describe('new bucket form', () => {
  it('uses a real select for the backend and loads the owner read-only', async () => {
    backendService.listBackends.mockResolvedValue([
      { slug: 'office', baseUrl: 'https://dav.example.com', displayName: 'Office', createdAt: 0, updatedAt: 0, lastSeenAt: null, lastStatus: null },
    ]);
    render(
      <MemoryRouter initialEntries={['/new']}>
        <Routes>
          <Route path="/new" element={<NewVolumeView showNotice={vi.fn()} />} />
        </Routes>
      </MemoryRouter>,
    );

    const select = screen.getByRole('combobox', { name: 'Backend' });
    expect(select.tagName).toBe('SELECT');
    // One backend is preselected, so the owner resolves without a second choice.
    await waitFor(() => expect((screen.getByLabelText('Owner') as HTMLInputElement).value).toBe('alice'));
    expect((screen.getByLabelText('Owner') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText('Owner') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('modal keyboard behaviour', () => {
  it('moves focus into the dialog and traps Tab inside it', () => {
    render(
      <ModalShell onClose={vi.fn()} ariaLabel="Rename">
        <ModalHeader title="Rename" />
        <ModalBody>
          <input aria-label="New Name" />
          <button type="button">Save</button>
        </ModalBody>
      </ModalShell>,
    );

    const input = screen.getByLabelText('New Name');
    expect(document.activeElement).toBe(input);

    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // The close control and the save button are the last two; Tab from the end
    // wraps to the dialog's first focusable, never out into the page.
    expect(document.activeElement).not.toBe(save);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <ModalShell onClose={onClose} ariaLabel="Rename">
        <ModalBody>
          <input aria-label="New Name" />
        </ModalBody>
      </ModalShell>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
