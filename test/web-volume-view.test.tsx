// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The i18n double, held at a stable identity the way react-i18next's own hook
 * is stable.
 *
 * `useVolumeFiles` lists `t` in its effect deps, so a double that mints a fresh
 * function per render re-fires the PROPFIND on every render — an infinite
 * fetch loop that OOMs the worker rather than failing a test. The platform's
 * `t` only changes identity when the language does; a double that is correct
 * here has to say so.
 */
const i18nDouble = vi.hoisted(() => ({
  translation: { t: (key: string, fallback?: string) => fallback ?? key },
}));

/**
 * `initReactI18next` is stubbed because `VolumeView` pulls in `i18n.ts` (via
 * `lib/format`/`lib/api`), which runs a real `i18n.use(initReactI18next).init`
 * at import time. `useTranslation` stays stubbed so assertions read the
 * inline default strings, the same convention the other SPA tests use.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => i18nDouble.translation,
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const davClient = vi.hoisted(() => ({
  // An empty page settles the view's loading state; the mutation helpers are
  // listed so the mocked module carries the same surface the view imports,
  // and none of them is ever called here.
  listDirectory: vi.fn(async () => ({
    entries: [] as unknown[],
    page: 1,
    limit: 100,
    total: null,
    paged: false,
  })),
  createDirectory: vi.fn(async () => undefined),
  uploadFile: vi.fn(async () => undefined),
  deleteEntry: vi.fn(async () => undefined),
  moveEntry: vi.fn(async () => undefined),
  copyEntry: vi.fn(async () => undefined),
  downloadUrl: vi.fn(() => ''),
}));

vi.mock('../apps/web/src/services/davClient', () => davClient);

import { VolumeView } from '../apps/web/src/views/VolumeView';

/**
 * The bucket-name crumb is the one request in the bucket browser built inline
 * in JSX besides the download link, so it is the other one that can silently
 * lose the `?backend=` selector every `davClient` call carries.
 *
 * It is not cosmetic either. `useVolumeFiles` keys its fetch on `backend`, so a
 * crumb that dropped the selector re-issued the PROPFIND with none at all and
 * the router answered `409 Multiple backends match` — the listing failed to
 * reload on what should have been a trip back to the bucket home. An account
 * with a single registered backend never sees it (`resolveBackend`
 * short-circuits one candidate), which is how it survived.
 */

function renderVolume(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/alice/photos${search}`]}>
      <Routes>
        <Route path="/:owner/:volume" element={<VolumeView authorized showNotice={vi.fn()} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * The crumb's `href` — the attribute a real navigation goes to, and the reason
 * this is asserted instead of a simulated click: a click that passes tells you
 * nothing about where the link points.
 */
function crumbHref(): string | null {
  return screen.getByRole('link', { name: 'alice/photos' }).getAttribute('href');
}

describe('VolumeView bucket-name crumb', () => {
  it('carries the ?backend= selector', async () => {
    renderVolume('?backend=office&path=dir_A');
    await screen.findByRole('link', { name: 'alice/photos' });
    expect(crumbHref()).toBe('/alice/photos?backend=office');
  });

  it('stays selector-free when no backend was named', async () => {
    // A single registered backend needs no selector, and the router rejects an
    // unknown one — so an absent `backend` must produce no `?backend=` at all.
    renderVolume('?path=dir_A');
    await screen.findByRole('link', { name: 'alice/photos' });
    expect(crumbHref()).toBe('/alice/photos');
  });
});
