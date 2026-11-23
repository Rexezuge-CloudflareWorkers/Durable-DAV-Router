import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { cn } from '@rexezuge/web';
import type { RouterBackend } from '../../types';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { FieldHint, Input, Label, Select } from '../ui/Input';

/**
 * One row of the backend registry, shared by live backends and the replicas
 * tucked under them.
 *
 * The row deliberately knows nothing about grouping: its parent decides which
 * rows are visible and passes `isReplica` down for the badge and the indent.
 * Editing covers both name and replica relationship so a single Save produces
 * one PATCH — and one re-read — rather than two competing ones.
 */
export interface BackendRowProps {
  backend: RouterBackend;
  isReplica: boolean;
  editing: boolean;
  draftName: string;
  draftReplicaOf: string;
  probing: boolean;
  /**
  Live backends this row may point at. Excludes itself and other replicas.
  */
  replicaOptions: ReadonlyArray<{ slug: string; label: string }>;
  canBeReplica: boolean;
  onDraftNameChange: (value: string) => void;
  onDraftReplicaOfChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onCheck: () => void;
  onDelete: () => void;
}

export function BackendRow({
  backend,
  isReplica,
  editing,
  draftName,
  draftReplicaOf,
  probing,
  replicaOptions,
  canBeReplica,
  onDraftNameChange,
  onDraftReplicaOfChange,
  onStartEdit,
  onCancelEdit,
  onSave,
  onCheck,
  onDelete,
}: BackendRowProps) {
  const { t } = useTranslation();
  const healthy = backend.lastStatus !== null && backend.lastStatus >= 200 && backend.lastStatus < 400;

  return (
    <li
      className={cn(
        'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3 transition-colors duration-150 hover:border-[var(--color-surface-4)]',
        isReplica && 'ml-4 border-l-2 border-l-[var(--color-accent)]/50',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <Input
                autoFocus
                aria-label={t('backends.displayName', 'Display Name')}
                placeholder={t('backends.displayName', 'Display Name')}
                value={draftName}
                onChange={(event) => onDraftNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSave();
                  else if (event.key === 'Escape') onCancelEdit();
                }}
                className="h-8 w-56 text-sm"
              />
              {canBeReplica && (
                <div className="space-y-1">
                  <Label htmlFor={`replica-of-${backend.slug}`}>{t('backends.replicaOf', 'Replica Of')}</Label>
                  <Select
                    id={`replica-of-${backend.slug}`}
                    value={draftReplicaOf}
                    onChange={(event) => onDraftReplicaOfChange(event.target.value)}
                    className="h-8 w-56 py-1 text-sm"
                  >
                    <option value="">{t('backends.liveBackend', 'Live Backend')}</option>
                    {replicaOptions.map((option) => (
                      <option key={option.slug} value={option.slug}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  <FieldHint>{t('backends.replicaOfHint', 'Replicas Stay Collapsed Until Expanded.')}</FieldHint>
                </div>
              )}
              {!canBeReplica && <FieldHint>{t('backends.hasReplicasHint', 'This Backend Has Replicas And Must Stay Live.')}</FieldHint>}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" onClick={onSave}>
                  {t('common.save', 'Save')}
                </Button>
                <Button variant="ghost" size="sm" onClick={onCancelEdit}>
                  {t('common.cancel', 'Cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-[var(--color-text-primary)]">
              <span className="truncate">{backend.displayName ? `${backend.displayName} (${backend.slug})` : backend.slug}</span>
              {isReplica && (
                <span className="rounded-md bg-[var(--color-surface-4)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-text-secondary)]">
                  {t('backends.replicaBadge', 'Replica')}
                </span>
              )}
            </p>
          )}
          <p className="mt-0.5 break-all font-mono text-xs text-[var(--color-text-muted)]">{backend.baseUrl}</p>
          {/*
           * The cached last probe, not a live one — see BackendsSettingsCard.
           */}
          <p
            className={cn(
              'mt-1.5 text-xs',
              !backend.lastStatus && 'text-[var(--color-text-muted)]',
              backend.lastStatus && healthy && 'text-[var(--color-success-text)]',
              backend.lastStatus && !healthy && 'text-[var(--color-error-text)]',
            )}
          >
            {backend.lastStatus ? `● ${backend.lastStatus}` : t('backends.statusNeverProbed', '● Never Probed')}
            {backend.lastSeenAt
              ? ` · ${t('backends.lastSeen', 'Last Seen {{when}}', { when: new Date(backend.lastSeenAt * 1000).toLocaleString() })}`
              : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!editing && (
            <IconButton
              label={t('common.edit', 'Edit')}
              onClick={() => {
                onDraftNameChange(backend.displayName ?? '');
                onDraftReplicaOfChange(backend.replicaOf ?? '');
                onStartEdit();
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <Button variant="secondary" size="sm" loading={probing} onClick={onCheck}>
            {probing ? t('backends.probing', 'Checking…') : t('backends.probe', 'Check')}
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete}>
            {t('common.delete', 'Delete')}
          </Button>
        </div>
      </div>
    </li>
  );
}
