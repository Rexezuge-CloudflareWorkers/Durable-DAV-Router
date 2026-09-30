import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DavEntry } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { parentDavPath, stripSlashes } from '../../lib/davXml';
import { useBusyAction } from '../../hooks/useBusyAction';
import { copyEntry, createDirectory, deleteEntry, downloadUrl, moveEntry, uploadFile } from '../../services/davClient';

type NoticeFn = (type: 'success' | 'error', text: string) => void;

/**
 * Reject a name that is empty, a traversal segment, or contains a path separator.
 *
 * Both the mkdir and the rename field need this, and they needed it separately
 * for a while — which is how the mkdir dialog ended up accepting `a/b` while the
 * rename dialog refused it, each with its own copy of the rule and its own
 * message.
 */
function singleSegmentName(raw: string): string | null {
  const leaf = stripSlashes(raw.trim());
  // `null` is the rejection, so both the "empty" and the "contains a separator"
  // cases return the same thing and the caller has one branch, not two.
  return leaf === '' || leaf.includes('/') ? null : leaf;
}

/**
 * Mutation slice for file operations: one async action per user intent.
 *
 * Every action runs through `useBusyAction`, so `busy` is true for the whole of
 * an action that is in flight and false on every other path — including one that
 * throws. The view wires buttons to these and nothing else.
 */
function useVolumeMutations(
  owner: string,
  volume: string,
  path: string,
  showNotice: NoticeFn,
  refresh: () => void,
  backend?: string | null,
) {
  const { t } = useTranslation();
  const { busy, run } = useBusyAction();
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [renaming, setRenaming] = useState<DavEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<DavEntry | null>(null);
  const [preview, setPreview] = useState<{ entry: DavEntry; text: string | null } | null>(null);

  /**
   * Run an action and report the outcome.
   *
   * The notice pair is the whole of what a mutation does on failure, and it is
   * what every one of these five used to spell out — each with its own key, which
   * is right, and its own `catch`, which was five chances to differ.
   */
  const attempt = useCallback(
    async (action: () => Promise<void>, messages: { doneKey: string; doneDefault: string; failedKey: string; failedDefault: string }): Promise<void> => {
      try {
        await action();
        showNotice('success', t(messages.doneKey, messages.doneDefault));
        refresh();
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, messages.failedKey, messages.failedDefault));
      }
    },
    [refresh, showNotice, t],
  );

  const doMkdir = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const leaf = singleSegmentName(mkdirName);
      if (!leaf) return showNotice('error', t('files.invalidFolderName', 'Enter A Single Folder Name.'));
      await run(() =>
        attempt(
          async () => {
            await createDirectory(owner, volume, path === '' ? leaf : `${path}/${leaf}`, backend);
            setMkdirOpen(false);
            setMkdirName('');
          },
          { doneKey: 'files.folderCreated', doneDefault: 'Folder Created.', failedKey: 'errors.failedToCreateFolder', failedDefault: 'Failed To Create Folder.' },
        ),
      );
    },
    [mkdirName, owner, volume, path, run, attempt, showNotice, t, backend],
  );

  const doUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      await run(() =>
        attempt(
          async () => {
            // Sequential on purpose: a parallel upload of 200 files is 200
            // concurrent subrequests against one Durable Object, which is the
            // shape that produces a 429 rather than a file.
            for (const file of Array.from(files)) {
              const target = path === '' ? file.name : `${path}/${file.name}`;
              await uploadFile(owner, volume, target, file, backend);
            }
          },
          { doneKey: 'files.uploaded', doneDefault: 'Upload Complete.', failedKey: 'errors.failedToUpload', failedDefault: 'Failed To Upload File.' },
        ),
      );
    },
    [owner, volume, path, run, attempt, backend],
  );

  const doDelete = useCallback(async () => {
    if (!deleting) return;
    const entry = deleting;
    await run(() =>
      attempt(
        async () => {
          await deleteEntry(owner, volume, entry.path, backend);
          setDeleting(null);
        },
        { doneKey: 'files.deleted', doneDefault: 'Deleted.', failedKey: 'errors.failedToDelete', failedDefault: 'Failed To Delete.' },
      ),
    );
  }, [deleting, owner, volume, run, attempt, backend]);

  const doRename = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!renaming) return;
      const leaf = singleSegmentName(renameValue);
      if (!leaf) return showNotice('error', t('files.invalidName', 'Enter A Single File Or Folder Name.'));
      const parent = parentDavPath(renaming.path) ?? '';
      const target = parent === '' ? leaf : `${parent}/${leaf}`;
      // A rename to the name it already has is not an error the user needs told
      // about; the backend would answer 412 and the dialog would stay open.
      if (target === renaming.path) {
        setRenaming(null);
        return;
      }
      await run(() =>
        attempt(
          async () => {
            await moveEntry(owner, volume, renaming.path, target, true, backend);
            setRenaming(null);
          },
          { doneKey: 'files.renamed', doneDefault: 'Renamed.', failedKey: 'errors.failedToRename', failedDefault: 'Failed To Rename.' },
        ),
      );
    },
    [renaming, renameValue, owner, volume, run, attempt, showNotice, t, backend],
  );

  const doDuplicate = useCallback(
    async (entry: DavEntry) => {
      await run(() =>
        attempt(() => copyEntry(owner, volume, entry.path, `${entry.path}-copy`, true, backend).then(() => undefined), {
          doneKey: 'files.duplicated',
          doneDefault: 'Duplicated.',
          failedKey: 'errors.failedToDuplicate',
          failedDefault: 'Failed To Duplicate.',
        }),
      );
    },
    [owner, volume, run, attempt, backend],
  );

  /**
   * Open a file: inline for anything small enough to read, in a new tab otherwise.
   *
   * The tab is the fallback for *every* failure, not just an unreadable body —
   * a user who asked to see a file and got a spinner learns nothing, whereas a
   * download that succeeds is a better outcome than a preview they then dismiss.
   */
  const openPreview = useCallback(
    async (entry: DavEntry, openPath: (p: string) => void) => {
      if (entry.isCollection) {
        openPath(entry.path);
        return;
      }
      const url = downloadUrl(owner, volume, entry.path, backend);
      const openExternally = (): void => {
        globalThis.open(url, '_blank', 'noopener');
      };
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const readable = (blob.type.startsWith('text/') || blob.size < 65_536) && blob.size < 1_048_576;
        if (!readable) {
          openExternally();
          return;
        }
        setPreview({ entry, text: await blob.text().catch(() => null) });
      } catch {
        openExternally();
      }
    },
    [owner, volume, backend],
  );

  return {
    busy,
    mkdirOpen,
    setMkdirOpen,
    mkdirName,
    setMkdirName,
    renaming,
    setRenaming,
    renameValue,
    setRenameValue,
    deleting,
    setDeleting,
    preview,
    setPreview,
    doMkdir,
    doUpload,
    doDelete,
    doRename,
    doDuplicate,
    openPreview,
  };
}

export { useVolumeMutations, singleSegmentName };
