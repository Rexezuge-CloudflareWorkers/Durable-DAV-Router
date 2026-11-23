import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Files, FolderUp, Plus, Settings2, Upload } from 'lucide-react';
import { cn } from '@rexezuge/web';
import type { VolumeDetail } from '../types';
import { parentDavPath, stripSlashes } from '../lib/davXml';
import { withBackendSelector } from '../lib/backendSelector';
import { clampPage, readStoredPageSize, storePageSize } from '../lib/davPage';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Tabs } from '../components/ui/Tabs';
import { BreadcrumbBar } from '../components/layout/BreadcrumbBar';
import { VolumeSettingsTab } from '../components/volume/VolumeSettingsTab';
import { VisibilityBadge } from '../components/ui/Badge';
import { useVolumeFiles } from './volume/useVolumeFiles';
import { useVolumeMutations } from './volume/useVolumeMutations';
import { VolumeFileList } from './volume/VolumeFileList';
import { VolumeFileModals } from './volume/VolumeFileModals';
import { VolumeFilePager } from './volume/VolumeFilePager';
import { AppPage, RefreshButton } from '@rexezuge/web';

/**
 * Normalise a `?path=` query value into a safe volume-relative path.
 *
 * `?path=` is user-supplied (share links, hand-edited URLs) and is fed straight
 * into `davClient.entryUrl`, so it must be validated here rather than trusted.
 * `stripSlashes` alone was not enough:
 *
 * - `encodeURIComponent` does not encode `.`, so `..` segments survived into
 *   the request URL and the browser normalised them out of the volume base —
 *   `?path=../../admin` issued a request to `/user/volumes/o/admin`.
 * - Empty segments (`a//b`) produce a guaranteed 400 from the server's
 *   `isValidInnerPath`.
 *
 * Anything that is not a plain non-empty, non-dot segment is dropped, so the
 * worst case is that the path silently becomes the volume root.
 */
function cleanPath(raw: string | null): string {
  const segments = stripSlashes(raw ?? '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return segments.every((segment) => !/[/\\]/.test(segment)) ? segments.join('/') : '';
}

// Thin composition root: routing + hook slices + presentational children.
function VolumeView({ authorized, showNotice }: { authorized: boolean | null; showNotice: (kind: 'success' | 'error', message: string) => void }) {
  const { owner = '', volume = '' } = useParams<{ owner: string; volume: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const path = cleanPath(params.get('path'));
  const backend = params.get('backend')?.trim() ? (params.get('backend') as string).trim() : null;
  const activeTab = params.get('tab') === 'settings' ? 'settings' : 'files';
  // `?page=` is user-supplied like `?path=`, so it is clamped on read rather
  // than trusted. Page 1 is omitted from the URL entirely, which keeps a plain
  // folder link free of paging noise.
  const page = clampPage(params.get('page'));
  const [pageSize, setPageSizeState] = useState(readStoredPageSize);
  const [volumeDetail, setVolumeDetail] = useState<VolumeDetail | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const { entries, status, refresh, crumbs, notice, consumeNotice, paging } = useVolumeFiles(owner, volume, path, authorized, backend, page, pageSize);
  const mutations = useVolumeMutations(owner, volume, path, showNotice, refresh, backend);

  useEffect(() => {
    if (!notice) {
      return;
    }

    showNotice(notice.kind, notice.message);
    consumeNotice();
  }, [notice, showNotice, consumeNotice]);

  // Both setters rebuild the whole query object from scratch rather than
  // patching it, so `page` has to be threaded through both explicitly. A
  // folder change resets to page 1: page 7 of the previous folder is not a
  // meaningful position in the new one, and keeping it would show an empty list
  // for a folder with more than one page.
  const setPath = useCallback(
    (next: string, nextPage = 1) => {
      const nextParams: Record<string, string> = {};
      if (next !== '') nextParams['path'] = next;
      if (activeTab === 'settings') nextParams['tab'] = 'settings';
      if (backend) nextParams['backend'] = backend;
      if (nextPage > 1) nextParams['page'] = String(nextPage);
      setParams(nextParams, { replace: false });
    },
    [setParams, activeTab, backend],
  );

  const setTab = useCallback(
    (tab: 'files' | 'settings') => {
      const nextParams: Record<string, string> = {};
      if (path !== '') nextParams['path'] = path;
      if (tab === 'settings') nextParams['tab'] = 'settings';
      if (backend) nextParams['backend'] = backend;
      setParams(nextParams, { replace: false });
    },
    [setParams, path, backend],
  );

  const setPage = useCallback(
    (next: number) => {
      const nextParams: Record<string, string> = {};
      if (path !== '') nextParams['path'] = path;
      if (activeTab === 'settings') nextParams['tab'] = 'settings';
      if (backend) nextParams['backend'] = backend;
      if (next > 1) nextParams['page'] = String(next);
      // Correcting a stale link replaces rather than pushes, so the back button
      // does not walk straight back into the page that needed correcting.
      setParams(nextParams, { replace: next === 1 });
    },
    [setParams, path, activeTab, backend],
  );

  // The backend clamps an out-of-range `?page=` and echoes back the page it
  // actually served, so a link that has gone stale (`?page=9` after the folder
  // shrank) would otherwise leave the address bar disagreeing with the rows on
  // screen. Put the served page in the URL once the rows have settled.
  useEffect(() => {
    if (status !== 'ready' || !paging.paged || paging.page === page) return;
    setPage(paging.page);
  }, [status, paging.paged, paging.page, page, setPage]);

  // Changing the page size keeps the first row on screen: switching 100 -> 250
  // while on page 3 should show rows 1-250, not 501-750 of a list the user was
  // reading at rows 201-300.
  const changePageSize = useCallback(
    (next: number) => {
      storePageSize(next);
      setPageSizeState(next);
      setPath(path, 1);
    },
    [path, setPath],
  );

  // The bucket-name crumb is a real link, so its `to` is the whole fix. It used
  // to point at a bare `/${owner}/${volume}`, which drops the selector every
  // `davClient` call carries, and `useVolumeFiles` re-keys on `backend`: the
  // PROPFIND then went out with no selector and the router answered
  // `409 Multiple backends match`, so a trip back to the bucket home failed
  // the listing instead. A single-backend account never sees it, which is how
  // it survived review.
  //
  // There is deliberately no `onClick` here. The target already means "root
  // path, files tab, selector kept" — the only two setters a handler would
  // call — and an `onClick` on a `Link` runs even on a ⌘-click or a
  // middle-click, where the link declines to navigate but the handler does not:
  // the open tab would be navigated away while the new tab opened.
  const crumbHref = withBackendSelector(`/${owner}/${volume}`, backend);
  const title = path === '' ? t('files.root', 'Files') : (path.split('/').pop() ?? path);

  return (
    <div>
      <BreadcrumbBar
        crumb={
          <>
            <Link to={crumbHref} className="font-semibold hover:text-[var(--color-accent)]">
              {owner}/{volume}
            </Link>
            {activeTab === 'files' &&
              crumbs.map((segment, index) => (
                <span key={`${segment}-${index}`}>
                  <ChevronRight className="mx-1 inline h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                  <button
                    type="button"
                    className="rounded font-medium hover:text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
                    onClick={() => setPath(crumbs.slice(0, index + 1).join('/'))}
                  >
                    {segment}
                  </button>
                </span>
              ))}
            {volumeDetail && (
              <span className="ml-2 align-middle">
                <VisibilityBadge isPrivate={volumeDetail.isPrivate} />
              </span>
            )}
          </>
        }
        actions={<RefreshButton onRefresh={refresh} loading={status === 'loading'} label={t('common.refresh', 'Refresh')} />}
      />

      <div className="mx-auto flex max-w-7xl gap-2 px-4 pt-4 sm:px-6">
        <Tabs
          label={t('volumes.bucketSections', 'Bucket Sections')}
          value={activeTab}
          onChange={setTab}
          items={[
            { value: 'files', label: t('volumes.filesTab', 'Files'), icon: <Files className="h-3.5 w-3.5" /> },
            { value: 'settings', label: t('volumes.settingsTab', 'Settings'), icon: <Settings2 className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>

      {activeTab === 'settings' ? (
        <AppPage>
          <VolumeSettingsTab
            owner={owner}
            volume={volume}
            showNotice={showNotice}
            onUpdated={setVolumeDetail}
            onDeleted={() => void navigate('/')}
            backend={backend}
          />
        </AppPage>
      ) : (
        <AppPage>
          <Card
            className={cn('relative', dragging && 'ring-2 ring-[var(--color-accent)]/60')}
          >
            <div
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setDragging(false);
              }}
              onDrop={(event) => {
                if (event.dataTransfer.files.length === 0) return;
                event.preventDefault();
                setDragging(false);
                void mutations.doUpload(event.dataTransfer.files);
              }}
              className="space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {paging.total === null
                      ? t('files.itemCount', '{{count}} Items', { count: entries.length })
                      : t('files.itemCountTotal', '{{count}} Items', { count: paging.total })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void mutations.doUpload(e.target.files);
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                  />
                  <Button variant="primary" size="sm" disabled={mutations.busy} onClick={() => fileRef.current?.click()}>
                    <Upload className="h-3.5 w-3.5" />
                    {t('files.upload', 'Upload')}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={mutations.busy} onClick={() => mutations.setMkdirOpen(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('files.newFolder', 'New Folder')}
                  </Button>
                </div>
              </div>

              {path !== '' && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
                  onClick={() => setPath(parentDavPath(path) ?? '')}
                >
                  <FolderUp className="h-3.5 w-3.5" />
                  {t('files.up', 'Up To Parent Folder')}
                </button>
              )}

              <VolumeFileList
                owner={owner}
                volume={volume}
                backend={backend}
                entries={entries}
                status={status}
                busy={mutations.busy}
                onPreview={(e) => void mutations.openPreview(e, setPath)}
                onRename={(e) => {
                  mutations.setRenaming(e);
                  mutations.setRenameValue(e.name);
                }}
                onDuplicate={(e) => void mutations.doDuplicate(e)}
                onDelete={(e) => mutations.setDeleting(e)}
              />

              <VolumeFilePager
                page={paging.page}
                limit={pageSize}
                total={paging.total}
                paged={paging.paged}
                onPageChange={setPage}
                onPageSizeChange={changePageSize}
              />

              {dragging && (
                <div className="pointer-events-none absolute left-0 top-0 flex h-full w-full items-center justify-center rounded-xl bg-[var(--color-surface-base)]/80">
                  <p className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-surface-2)] px-4 py-2 text-sm text-[var(--color-text-primary)]">
                    <Upload className="h-4 w-4 text-[var(--color-accent)]" />
                    {t('files.dropToUpload', 'Drop Files To Upload Here.')}
                  </p>
                </div>
              )}
            </div>
          </Card>
          <VolumeFileModals
            busy={mutations.busy}
            mkdirOpen={mutations.mkdirOpen}
            mkdirName={mutations.mkdirName}
            renaming={mutations.renaming}
            renameValue={mutations.renameValue}
            deleting={mutations.deleting}
            preview={mutations.preview}
            onCloseMkdir={() => mutations.setMkdirOpen(false)}
            onMkdirName={mutations.setMkdirName}
            onMkdirSubmit={mutations.doMkdir}
            onRenameValue={mutations.setRenameValue}
            onRenameSubmit={mutations.doRename}
            onCloseRename={() => mutations.setRenaming(null)}
            onConfirmDelete={() => void mutations.doDelete()}
            onCancelDelete={() => mutations.setDeleting(null)}
            onClosePreview={() => mutations.setPreview(null)}
          />
        </AppPage>
      )}
    </div>
  );
}

export { VolumeView };
