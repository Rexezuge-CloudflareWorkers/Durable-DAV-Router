// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, string>) => {
      let text = fallback ?? key;
      const entries = Object.entries(vars ?? {});
      for (const [k, v] of entries) text = text.replace(`{{${k}}}`, v);
      return text;
    },
  }),
}));

const updateVolume = vi.fn();

vi.mock('../apps/web/src/services/volumeService', () => ({
  updateVolume: (...args: unknown[]) => updateVolume(...args),
}));

import { HrefPrefixModeCard } from '../apps/web/src/components/volume/HrefPrefixModeCard';
import type { VolumeDetail } from '../apps/web/src/types';

const BASE_DETAIL: VolumeDetail = {
  owner: 'alice',
  name: 'photos',
  fullName: 'alice/photos',
  description: null,
  isPrivate: true,
  hrefPrefixMode: 'base',
  href: '/alice/photos/',
};

function renderCard(detail: VolumeDetail = BASE_DETAIL, backend?: string | null) {
  const onUpdated = vi.fn();
  const showNotice = vi.fn();
  render(
    <HrefPrefixModeCard
      owner={detail.owner}
      volume={detail.name}
      detail={detail}
      showNotice={showNotice}
      onUpdated={onUpdated}
      backend={backend}
    />,
  );
  return { onUpdated, showNotice };
}

const select = () => screen.getByLabelText('Link Prefix') as unknown as HTMLSelectElement;
const save = () => screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;

beforeEach(() => {
  updateVolume.mockReset();
});

describe('href prefix mode card', () => {
  it('shows the current mode and leaves saving disabled until something changes', () => {
    renderCard();
    expect(select().value).toBe('base');
    expect(save().disabled).toBe(true);
  });

  it('previews each mode with a concrete example path', () => {
    // The point of the control is that the owner can see which shape their
    // clients will get; "Base" or "Root" alone does not convey that.
    renderCard();
    expect(screen.getByText('Example: /alice/photos/photos/image.jpg')).toBeTruthy();
    fireEvent.change(select(), { target: { value: 'root' } });
    expect(screen.getByText('Example: /photos/image.jpg')).toBeTruthy();
  });

  it('says the setting lives on the backend, not just in this router', () => {
    // The router is a passthrough, so the control changes what a client
    // connected straight to the backend sees too. Omitting that from the copy
    // would let an owner make a global change thinking it was router-local.
    renderCard();
    expect(screen.getByText(/Stored On The Backend/i)).toBeTruthy();
  });

  it('persists the new mode and reports the server response, not the selection', async () => {
    const updated = { ...BASE_DETAIL, hrefPrefixMode: 'root' as const };
    updateVolume.mockResolvedValue(updated);
    const { onUpdated, showNotice } = renderCard();

    fireEvent.change(select(), { target: { value: 'root' } });
    fireEvent.click(save());

    expect(updateVolume).toHaveBeenCalledWith('alice', 'photos', { hrefPrefixMode: 'root' }, undefined);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
    expect(showNotice).toHaveBeenCalledWith('success', 'Bucket Link Prefix Updated.');
  });

  it('carries the backend selector so the PATCH reaches the right backend', async () => {
    // Every router volume call is `?backend=`-qualified; dropping it here would
    // silently target whichever backend resolved the owner, and with several
    // registered that is a 409 rather than a save.
    const onUpdated = vi.fn();
    updateVolume.mockResolvedValue(BASE_DETAIL);
    render(
      <HrefPrefixModeCard
        owner={BASE_DETAIL.owner}
        volume={BASE_DETAIL.name}
        detail={BASE_DETAIL}
        showNotice={vi.fn()}
        onUpdated={onUpdated}
        backend="office"
      />,
    );

    fireEvent.change(select(), { target: { value: 'root' } });
    fireEvent.click(save());

    expect(updateVolume).toHaveBeenCalledWith('alice', 'photos', { hrefPrefixMode: 'root' }, 'office');
    // Awaited so the card's `saving` state settles inside `act`.
    await waitFor(() => expect(save().disabled).toBe(true));
  });

  it('snaps back to the stored mode when the save fails', async () => {
    // Without this the select keeps showing the mode the owner tried to set, so
    // the UI would claim a compatibility change the backend never accepted.
    updateVolume.mockRejectedValue(new Error('nope'));
    const { onUpdated, showNotice } = renderCard();

    fireEvent.change(select(), { target: { value: 'root' } });
    expect(select().value).toBe('root');
    fireEvent.click(save());

    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', expect.any(String)));
    expect(select().value).toBe('base');
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('renders an already-root bucket as root, with the change available', () => {
    renderCard({ ...BASE_DETAIL, hrefPrefixMode: 'root' });
    expect(select().value).toBe('root');
    expect(save().disabled).toBe(true);
  });
});
