// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

const backendService = vi.hoisted(() => ({
  listBackends: vi.fn(async () => [] as unknown[]),
  createBackend: vi.fn(async () => ({ slug: 'r1' })),
}));

vi.mock('../apps/web/src/services/backendService', () => backendService);

import { NewBackendView } from '../apps/web/src/views/NewBackendView';

function renderForm() {
  const showNotice = vi.fn();
  render(
    <MemoryRouter>
      <NewBackendView showNotice={showNotice} />
    </MemoryRouter>,
  );
  return showNotice;
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'r1' } });
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://r1.example.com' } });
}

beforeEach(() => {
  backendService.listBackends.mockReset();
  backendService.listBackends.mockResolvedValue([
    { slug: 'live', displayName: 'Live', replicaOf: null },
    { slug: 'already-replica', displayName: 'Old', replicaOf: 'live' },
  ]);
  backendService.createBackend.mockReset();
  backendService.createBackend.mockResolvedValue({ slug: 'r1' });
});

afterEach(() => {
  cleanup();
});

describe('NewBackendView replica selector', () => {
  it('offers only live backends and sends the chosen parent', async () => {
    renderForm();
    const select = await screen.findByLabelText('Replica Of');
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual(['', 'live']);

    fillRequired();
    fireEvent.change(select, { target: { value: 'live' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register Backend' }));

    await waitFor(() => {
      expect(backendService.createBackend).toHaveBeenCalledWith({
        slug: 'r1',
        baseUrl: 'https://r1.example.com',
        displayName: null,
        replicaOf: 'live',
      });
    });
  });

  it('registers a live backend when no parent is picked', async () => {
    renderForm();
    await screen.findByLabelText('Replica Of');
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Register Backend' }));
    await waitFor(() => {
      expect(backendService.createBackend).toHaveBeenCalledWith(expect.objectContaining({ replicaOf: null }));
    });
  });
});
