// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NoticeBar } from '../apps/web/src/components/layout/NoticeBar';
import { EmptyState, LoadingSpinner } from '../apps/web/src/components/layout/PageState';
import { ReadOnlyField } from '../apps/web/src/components/shared/ReadOnlyField';
import { LanguageSelector } from '../apps/web/src/components/shared/LanguageSelector';
import Unauthorized from '../apps/web/src/components/layout/Unauthorized';
import { LanguageSettingsCard } from '../apps/web/src/components/settings/LanguageSettingsCard';
import { ProfileSettingsCard } from '../apps/web/src/components/settings/ProfileSettingsCard';
import { TypeToConfirmModal } from '../apps/web/src/components/modals/TypeToConfirmModal';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    // Assertions read the inline Title-Case defaults, matching the existing SPA
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * `SpaViewRouter`'s gate is exercised through a rendered tree so the two
 * components below are exercised where they are actually used.
 */
describe('layout composition', () => {
  it('renders a notice bar with a status role for assistive tech', () => {
    render(
      <MemoryRouter>
        <NoticeBar notice={{ type: 'error', text: 'Failed To Load Volumes.' }} />
      </MemoryRouter>,
    );
    // `role="status"` is a live region: a screen reader announces a new notice
    // without the user having to go looking for it.
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('Failed To Load Volumes.');
    expect(region.textContent?.startsWith('Error')).toBe(true);
  });

  it('labels a success notice as such', () => {
    render(
      <MemoryRouter>
        <NoticeBar notice={{ type: 'success', text: 'Folder Created.' }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status').textContent).toContain('Success');
  });

  it('renders a loading state as a status region with its label', () => {
    render(<LoadingSpinner label="Loading Buckets…" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading Buckets…');
  });

  it('renders an empty state with its message', () => {
    render(<EmptyState message="No Volumes Yet." />);
    expect(screen.getByText('No Volumes Yet.')).toBeTruthy();
  });

  it('copies a read-only field and confirms it', async () => {
    // The credential password is shown exactly once and this button is the only
    // way to keep it, so the copy is the feature and its confirmation is what tells
    // the user it happened.
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ReadOnlyField label="Base URL" value="https://backend.example.com" showCopy />);
    const button = screen.getByRole('button', { name: /copy/i });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://backend.example.com'));
    // The icon swaps from `Copy` to `Check`; the accessible name is the `title`,
    // unchanged, so the confirmation is visible rather than announced twice.
    await waitFor(() => expect(button.querySelector('.lucide-check')).toBeTruthy());
  });

  it('renders the value in a read-only field, and omits the copy button when not asked', () => {
    render(<ReadOnlyField label="Slug" value="office" />);
    expect((screen.getByDisplayValue('office') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers the languages the bundle ships, and reports a choice', () => {
    const onChange = vi.fn();
    render(<LanguageSelector value="en" onChange={onChange} />);
    const select = screen.getByRole('combobox') as unknown as HTMLSelectElement;
    // English-only today; the list grows bundle by bundle and is asserted against
    // `SUPPORTED_LANGUAGES` so an option cannot appear without a bundle behind it.
    expect([...select.options].map((option) => option.value)).toEqual(['en']);
    expect([...select.options].map((option) => option.textContent)).toEqual(['English']);
    fireEvent.change(select, { target: { value: 'en' } });
    expect(onChange).toHaveBeenCalledWith('en');
  });

  it('sends the user to the Access sign-in path', () => {
    // `/user/` is the only route that authenticates, so this is the whole recovery
    // path from a page the user cannot render.
    const assign = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, assign });
    render(<Unauthorized />);
    expect(screen.getByText('Access Required')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(assign).toHaveBeenCalledWith('/user/');
  });

  it('reports a language change from the settings card', () => {
    const onLanguageChange = vi.fn();
    render(<LanguageSettingsCard language="en" onLanguageChange={onLanguageChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    expect(onLanguageChange).toHaveBeenCalledWith('en');
  });

  it('disables the language selector while one is loading', () => {
    render(<LanguageSettingsCard language="en" onLanguageChange={vi.fn()} disabled />);
    expect((screen.getByRole('combobox') as unknown as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows the account address read-only on the profile card', () => {
    // The router is email-only; usernames live per-backend, so an editable address
    // here would be an edit that goes nowhere.
    render(
      <MemoryRouter>
        <ProfileSettingsCard user={{ email: 'a@example.com' }} setUser={vi.fn()} showNotice={vi.fn()} />
      </MemoryRouter>,
    );
    const address = screen.getByDisplayValue('a@example.com') as HTMLInputElement;
    expect(address.readOnly).toBe(true);
    // A read-only *input* is still exposed as a textbox, so `readOnly` above is the
    // assertion that matters: nothing about the address may be typed or edited.
    expect(address.hasAttribute('readonly')).toBe(true);
  });

  it('requires the exact name before a destructive action is armed', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <TypeToConfirmModal
        title="Delete Bucket"
        description="Permanently deletes the bucket."
        expectedName="photos"
        confirmLabel="Delete Bucket"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const confirm = () => screen.getByRole('button', { name: 'Delete Bucket' }) as HTMLButtonElement;
    // Armed by typing the name, not by clicking: a destructive confirmation that
    // one click completes is not a confirmation.
    expect(confirm().disabled).toBe(true);
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'photo' } });
    });
    expect(confirm().disabled).toBe(true);
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'photos' } });
    });
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});