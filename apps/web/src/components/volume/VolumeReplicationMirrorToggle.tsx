import { useTranslation } from 'react-i18next';

/**
 * `mirrorDeletions`: the control that can make a sync pass *delete* a file this
 * bucket holds.
 *
 * Its own module rather than a block inside `VolumeReplicationForm`, for the same
 * reason the card is a composer over form/row/decisions: this is the one control
 * in the settings UI whose failure mode is data loss rather than a wrong label,
 * and it carries its own explanation for that reason. Rendering it inline is how
 * it ended up the last thirty lines of a file about something else.
 *
 * ## Why it is rendered only under `pull-only`
 *
 * The backend reads the flag in `pull-only` alone and answers `400` for `true`
 * anywhere else — not as a no-op, because a stored flag nothing reads is a
 * setting that appears to work. So the parent keys on the mode and this component
 * does not decide it: it cannot know whether the backend in front of it is new
 * enough, and must not offer a control whose only outcome would be a refusal.
 *
 * ## Why it sits *below* the mode explanation
 *
 * The explanation is what tells the owner that in this mode the remote is the
 * writer. This box is the difference between "nothing here is ever deleted" and
 * "anything the remote lacks is deleted here", so it reads as a consequence of
 * the sentence above it rather than as an unrelated setting. Unchecked by
 * default, and the help text says which state is which — the safe one is the
 * default *and* the safe-sounding one, which is not something an owner should
 * have to infer from an unlabelled box.
 */
export function VolumeReplicationMirrorToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]" htmlFor="replication-mirror-deletions">
        <input
          id="replication-mirror-deletions"
          type="checkbox"
          className="mt-1"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {t('replication.mirrorDeletions', 'Delete Files Here That The Remote Does Not Have')}
          <span className="block text-xs text-[var(--color-text-muted)]">
            {t(
              'replication.mirrorDeletionsHelp',
              'Off, This Bucket Is A Safe Copy: The Remote’s Files Are Imported, And Nothing Here Is Ever Deleted. On, It Becomes An Exact Mirror — Off, Only After A Sync Pass Finishes Without Errors.',
            )}
          </span>
        </span>
      </label>
    </div>
  );
}