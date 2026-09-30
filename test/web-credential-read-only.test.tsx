// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * `initReactI18next` is included because the card pulls in `lib/format`, which
 * imports `i18n.ts`, and that module runs a real `i18n.use(initReactI18next).init`
 * at import time. `useTranslation` stays stubbed so assertions read the inline
 * default strings, the same convention the other SPA tests use.
 */
/**
 * A stable `t`, deliberately. The card's list effect lists `t` in its
 * dependency array (the house style across these components), so a `t` that is
 * a fresh closure on every render refetches the list after each optimistic
 * update and overwrites it with the server's stale row — which would make the
 * toggle tests pass or fail for reasons that have nothing to do with the code
 * under test. The other SPA tests here do not notice, because none of them
 * re-render after a write.
 */
const translate = (key: string, fallback?: string) => fallback ?? key;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const listBucketCredentials = vi.fn();
const createBucketCredential = vi.fn();
const revokeBucketCredential = vi.fn();
const setBucketCredentialReadOnly = vi.fn();

vi.mock('../apps/web/src/services/credentialService', () => ({
  listBucketCredentials: (...args: unknown[]) => listBucketCredentials(...args),
  createBucketCredential: (...args: unknown[]) => createBucketCredential(...args),
  revokeBucketCredential: (...args: unknown[]) => revokeBucketCredential(...args),
  setBucketCredentialReadOnly: (...args: unknown[]) => setBucketCredentialReadOnly(...args),
}));

import { VolumeCredentialsCard } from '../apps/web/src/components/volume/VolumeCredentialsCard';
import type { BucketCredential } from '../apps/web/src/types';

/**
 * The read-only toggle in the per-bucket credentials card.
 *
 * The router enforces nothing here — the backend owns the flag — so what the
 * card can get wrong is narrower and specific: send the wrong value, drop the
 * `?backend=` selector, or show a state the backend did not confirm. Each test
 * below is one of those. The optimistic update is deliberately exercised on its
 * failure path, because a toggle that optimistically shows read-only and then
 * silently keeps showing it after the backend refused is worse than no toggle
 * at all: the owner would believe a restriction was in place that was not.
 */

function credential(overrides: Partial<BucketCredential> = {}): BucketCredential {
  return {
    credentialId: 'c1',
    name: 'backup',
    username: 'photos-quiet-otter-1234',
    passwordPrefix: 'ddav_ab',
    passwordLastFour: 'wxyz',
    createdAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
    lastUsedAt: null,
    readOnly: false,
    ...overrides,
  };
}

function renderCard(rows: BucketCredential[], backend?: string | null) {
  const showNotice = vi.fn();
  render(<VolumeCredentialsCard owner="alice" volume="photos" showNotice={showNotice} backend={backend} />);
  return { showNotice };
}

const readOnlyCheckbox = () => screen.getByLabelText('Read-Only') as HTMLInputElement;
const createButton = () => screen.getByRole('button', { name: 'Create Credential' });
const toggleFor = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  listBucketCredentials.mockReset().mockResolvedValue([]);
  createBucketCredential.mockReset().mockResolvedValue({ username: 'u', password: 'p', readOnly: false });
  revokeBucketCredential.mockReset().mockResolvedValue(undefined);
  setBucketCredentialReadOnly.mockReset().mockResolvedValue(undefined);
});

describe('credentials card: creating a read-only credential', () => {
  it('defaults to full access', async () => {
    listBucketCredentials.mockResolvedValue([]);
    renderCard([]);
    await waitFor(() => expect(readOnlyCheckbox().checked).toBe(false));
  });

  it('passes readOnly before the backend selector', async () => {
    // The argument order is the whole hazard here: `backend` is the trailing
    // parameter throughout this component, so a `readOnly` appended after it
    // would be read as a `?backend=true` selector and 404 the request.
    listBucketCredentials.mockResolvedValue([]);
    createBucketCredential.mockResolvedValue({ username: 'u', password: 'p', readOnly: true });
    renderCard([], 'office');

    fireEvent.change(screen.getByPlaceholderText('Credential Name (e.g. laptop)'), { target: { value: 'backup' } });
    fireEvent.click(readOnlyCheckbox());
    fireEvent.click(createButton());

    await waitFor(() =>
      expect(createBucketCredential).toHaveBeenCalledWith('alice', 'photos', 'backup', undefined, true, 'office'),
    );
  });

  it('shows the copy-once password and the access level it was minted with', async () => {
    listBucketCredentials.mockResolvedValue([]);
    createBucketCredential.mockResolvedValue({ username: 'photos-quiet-otter-1', password: 'ddav_secret', readOnly: true });
    renderCard([]);

    fireEvent.change(screen.getByPlaceholderText('Credential Name (e.g. laptop)'), { target: { value: 'backup' } });
    fireEvent.click(readOnlyCheckbox());
    fireEvent.click(createButton());

    await waitFor(() => expect(screen.getByDisplayValue('ddav_secret')).toBeTruthy());
    // The badge follows the server's answer, not the checkbox: the backend
    // rejects a non-boolean rather than defaulting it, so a displayed value is
    // always one it actually applied.
    expect(screen.getByText('Read-Only Access')).toBeTruthy();
  });
});

describe('credentials card: listing the flag', () => {
  it('marks a read-only credential and offers to restore writes', async () => {
    listBucketCredentials.mockResolvedValue([credential({ readOnly: true })]);
    renderCard([]);
    await waitFor(() => expect(screen.getByText('Read-Only Access')).toBeTruthy());
    expect(toggleFor('Allow Writes')).toBeTruthy();
  });

  it('offers to restrict a full-access credential', async () => {
    listBucketCredentials.mockResolvedValue([credential({ readOnly: false })]);
    renderCard([]);
    await waitFor(() => expect(toggleFor('Make Read-Only')).toBeTruthy());
    expect(screen.queryByText('Read-Only Access')).toBeNull();
  });
});

describe('credentials card: flipping the flag', () => {
  it('sends the new value with the backend selector', async () => {
    listBucketCredentials.mockResolvedValue([credential({ readOnly: false })]);
    renderCard([], 'office');
    await waitFor(() => expect(toggleFor('Make Read-Only')).toBeTruthy());

    fireEvent.click(toggleFor('Make Read-Only'));

    await waitFor(() => expect(setBucketCredentialReadOnly).toHaveBeenCalledWith('alice', 'photos', 'c1', true, 'office'));
  });

  it('flips back, so the flag is not a one-way door', async () => {
    listBucketCredentials.mockResolvedValue([credential({ readOnly: true })]);
    renderCard([]);
    await waitFor(() => expect(toggleFor('Allow Writes')).toBeTruthy());

    fireEvent.click(toggleFor('Allow Writes'));

    await waitFor(() => expect(setBucketCredentialReadOnly).toHaveBeenCalledWith('alice', 'photos', 'c1', false, undefined));
  });

  it('reverts the optimistic badge and reports the failure when the backend refuses', async () => {
    // The failure path is the one that matters. A card that shows read-only
    // after the backend rejected the change would convince the owner a
    // restriction is in place that is not.
    listBucketCredentials.mockResolvedValue([credential({ readOnly: false })]);
    setBucketCredentialReadOnly.mockRejectedValue(new Error('nope'));
    const { showNotice } = renderCard([]);
    await waitFor(() => expect(toggleFor('Make Read-Only')).toBeTruthy());

    fireEvent.click(toggleFor('Make Read-Only'));

    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', 'Failed To Update Credential.'));
    await waitFor(() => expect(screen.queryByText('Read-Only Access')).toBeNull());
    expect(toggleFor('Make Read-Only')).toBeTruthy();
  });

  it('keeps the confirmed state and reports success', async () => {
    listBucketCredentials.mockResolvedValue([credential({ readOnly: false })]);
    const { showNotice } = renderCard([]);
    await waitFor(() => expect(toggleFor('Make Read-Only')).toBeTruthy());

    fireEvent.click(toggleFor('Make Read-Only'));

    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('success', 'Credential Is Now Read-Only.'));
    expect(screen.getByText('Read-Only Access')).toBeTruthy();
  });
});
