import { useTranslation } from 'react-i18next';
import { Copy, Download, File as FileIcon, Folder as FolderIcon, Pencil, Trash2 } from 'lucide-react';
import type { DavEntry } from '../../types';
import { formatBytes } from '../../lib/format';
import { downloadUrl } from '../../services/davClient';
import { EmptyState, LoadingSpinner } from '@rexezuge/web';
import { IconButton } from '../../components/ui/IconButton';

/**
Render a WebDAV RFC 1123 timestamp as something a person reads.
*/
function formatModified(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function VolumeFileList({
  owner,
  volume,
  backend,
  entries,
  status,
  busy,
  onPreview,
  onRename,
  onDuplicate,
  onDelete,
}: {
  owner: string;
  volume: string;
  /**
   * Upstream selector (`?backend=`), threaded through to every request this row
   * makes — including the download `href`.
   *
   * It used to be dropped for the download only, and that is a real failure
   * rather than a cosmetic one: with more than one backend registered the router
   * cannot resolve the volume, so the link 409'd and the browser saved the JSON
   * error body as the "downloaded" file. Every other action on this row (preview,
   * rename, duplicate, delete) already carried it.
   */
  backend?: string | null;
  entries: DavEntry[];
  status: 'loading' | 'ready' | 'missing';
  busy: boolean;
  onPreview: (entry: DavEntry) => void;
  onRename: (entry: DavEntry) => void;
  onDuplicate: (entry: DavEntry) => void;
  onDelete: (entry: DavEntry) => void;
}) {
  const { t } = useTranslation();
  if (status === 'loading') return <LoadingSpinner label={t('files.loadingFiles', 'Loading Files…')} />;
  if (status === 'missing' && entries.length === 0) {
    return <EmptyState message={t('files.notFound', 'This Folder Does Not Exist Or You Do Not Have Access.')} />;
  }
  if (entries.length === 0) {
    return <EmptyState message={t('files.emptyFolder', 'Empty Folder. Upload A File Or Create A Subfolder.')} />;
  }
  return (
    <ul className="-mx-2 divide-y divide-[var(--color-border)]">
      {entries.map((entry) => {
        const modified = formatModified(entry.lastModified);
        return (
          <li
            key={entry.path}
            className="group flex items-center gap-2 rounded-lg px-2 py-2.5 transition-colors duration-150 hover:bg-[var(--color-surface-2)]"
          >
            <span
              className={
                entry.isCollection
                  ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-3)] text-[var(--color-accent)]'
                  : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'
              }
            >
              {entry.isCollection ? <FolderIcon className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
            </span>
            <button
              type="button"
              className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
              onClick={() => onPreview(entry)}
            >
              <span className="block truncate text-sm font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)]">
                {entry.name}
                {entry.isCollection ? '/' : ''}
              </span>
              <span className="mt-0.5 block truncate text-xs tabular-nums text-[var(--color-text-muted)]">
                {entry.isCollection ? t('files.folder', 'Folder') : formatBytes(entry.size)}
                {modified ? ` · ${modified}` : ''}
              </span>
            </button>

            <span className="flex shrink-0 items-center gap-0.5 sm:opacity-60 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              {!entry.isCollection && (
                <a
                  href={downloadUrl(owner, volume, entry.path, backend)}
                  download={entry.name}
                  aria-label={t('files.download', 'Download')}
                  title={t('files.download', 'Download')}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors duration-150 hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
                >
                  <Download className="h-4 w-4" />
                </a>
              )}
              <IconButton label={t('files.rename', 'Rename')} disabled={busy} onClick={() => onRename(entry)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
              <IconButton label={t('files.duplicate', 'Duplicate')} disabled={busy} onClick={() => onDuplicate(entry)}>
                <Copy className="h-4 w-4" />
              </IconButton>
              <IconButton label={t('common.delete', 'Delete')} tone="danger" disabled={busy} onClick={() => onDelete(entry)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export { VolumeFileList };
