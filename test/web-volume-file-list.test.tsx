// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * `initReactI18next` is stubbed because the list pulls in `lib/format`, which
 * imports `i18n.ts`, and that module runs a real `i18n.use(initReactI18next).init`
 * at import time. `useTranslation` stays stubbed so assertions read the inline
 * default strings, the same convention the other SPA tests use.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { VolumeFileList } from '../apps/web/src/views/volume/VolumeFileList';
import type { DavEntry } from '../apps/web/src/types';

/**
 * The download link is the one request in this row set built inline in JSX, so it
 * is the one that can silently lose the `?backend=` selector every other action
 * carries. That is not cosmetic: with more than one backend registered the router
 * cannot resolve the volume, so the link 409s and the browser saves the JSON
 * error body as the "downloaded" file.
 */

const FILES = '/user/volumes/alice/photos/files';

const FILE_ENTRY: DavEntry = {
  href: '/alice/photos/dir_A/a.txt',
  name: 'a.txt',
  path: 'dir_A/a.txt',
  isCollection: false,
  size: 12,
  contentType: 'text/plain',
  lastModified: 'Wed, 01 Oct 2026 00:00:00 GMT',
  etag: '"abc"',
};

const DIR_ENTRY: DavEntry = {
  href: '/alice/photos/dir_A/',
  name: 'dir_A',
  path: 'dir_A',
  isCollection: true,
  size: null,
  contentType: null,
  lastModified: null,
  etag: null,
};

function renderList(backend?: string | null, entries: DavEntry[] = [FILE_ENTRY]) {
  return render(
    <VolumeFileList
      owner="alice"
      volume="photos"
      backend={backend}
      entries={entries}
      status="ready"
      busy={false}
      onPreview={vi.fn()}
      onRename={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

/**
The `href` of the row's download link, or null when the row has none.
*/
function downloadHref(name = 'Download'): string | null {
  const link = screen.queryByLabelText(name);
  return link?.getAttribute('href') ?? null;
}

describe('VolumeFileList download link', () => {
  it('carries the ?backend= selector', () => {
    renderList('office');
    expect(downloadHref()).toBe(`${FILES}/dir_A/a.txt?backend=office`);
  });

  it('stays selector-free when no backend was named', () => {
    // A single registered backend needs no selector, and the router rejects an
    // unknown one — so an absent `backend` must produce no `?backend=` at all.
    renderList(null);
    expect(downloadHref()).toBe(`${FILES}/dir_A/a.txt`);
  });

  it('offers no download for a collection', () => {
    // A folder has no bytes to fetch; the row is a navigation target instead.
    renderList('office', [DIR_ENTRY]);
    expect(downloadHref()).toBeNull();
  });

  it('addresses each row by its own parsed path', () => {
    renderList('office', [DIR_ENTRY, { ...FILE_ENTRY, name: 'b.txt', path: 'dir_B/b.txt' }]);
    expect(screen.getByLabelText('Download').getAttribute('href')).toBe(`${FILES}/dir_B/b.txt?backend=office`);
  });
});
