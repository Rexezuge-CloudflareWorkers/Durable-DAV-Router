// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * `initReactI18next` is included for the same reason the credential card's test
 * includes it — `lib/format` imports `i18n.ts`, which runs a real init at import
 * time. `useTranslation` stays stubbed so assertions read the inline defaults.
 */
/**
 * A stable `t` that interpolates.
 *
 * Interpolation is the reason this stub is not the one-liner the other SPA tests
 * use. Real i18next substitutes `{{count}}` / `{{winner}}` / `{{path}}` from the
 * options object, and three of the card's strings carry placeholders a user must
 * be able to read — "3 Consecutive Failed Attempts", "Other Version Kept At: …".
 * A stub that ignores options renders the literal `{{count}}`, and the assertions
 * below would then be pinning the *stub's* behaviour rather than the component's.
 *
 * Stable is the other half: a `t` that is a fresh closure on every render
 * re-runs every effect that depends on it.
 */
const translate = (key: string, fallback?: string, options?: Record<string, unknown>): string => {
  const text = fallback ?? key;
  if (!options) return text;
  return text.replaceAll(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = options[name];
    // Primitives only, as real i18next does. Coercing anything else would render
    // `[object Object]`, and a test could then pass against a string no user
    // would ever see.
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const listReplications = vi.fn();
const createReplication = vi.fn();
const updateReplication = vi.fn();
const deleteReplication = vi.fn();
const runReplicationNow = vi.fn();
const listReplicationConflicts = vi.fn();
const resolveReplicationConflict = vi.fn();

vi.mock('../apps/web/src/services/replicationService', async () => {
  // `REPLICATION_INTERVALS` is a value the component imports directly, so the
  // mock has to supply it rather than only the callables.
  const actual = await vi.importActual<typeof import('../apps/web/src/services/replicationService')>(
    '../apps/web/src/services/replicationService',
  );
  return {
    REPLICATION_INTERVALS: actual.REPLICATION_INTERVALS,
    intervalLabel: actual.intervalLabel,
    targetLabel: actual.targetLabel,
    listReplications: (...args: unknown[]) => listReplications(...args),
    createReplication: (...args: unknown[]) => createReplication(...args),
    updateReplication: (...args: unknown[]) => updateReplication(...args),
    deleteReplication: (...args: unknown[]) => deleteReplication(...args),
    runReplicationNow: (...args: unknown[]) => runReplicationNow(...args),
    listReplicationConflicts: (...args: unknown[]) => listReplicationConflicts(...args),
    resolveReplicationConflict: (...args: unknown[]) => resolveReplicationConflict(...args),
  };
});

import { VolumeReplicationCard } from '../apps/web/src/components/volume/VolumeReplicationCard';
import type { BucketReplication, ReplicationConflict } from '../apps/web/src/types';

/**
 * The per-bucket replication card.
 *
 * The router owns none of this — every call rides the `/user/volumes/:owner/:volume/*`
 * wildcard and the backend answers with its own projection. So what the card can
 * get wrong is narrow and specific: drop the `?backend=` selector and address the
 * wrong backend (or 409 a bucket that plainly exists), misread a `202` "started"
 * as a no-op, hide a target behind an empty state, or — the one that matters most
 * — mistake a backend predating the feature for a broken one. That last case is
 * asserted on both its branches: skew must read as skew, and a real refusal must
 * not be swallowed into it.
 */

function replication(overrides: Partial<BucketReplication> = {}): BucketReplication {
  return {
    replicationId: 'r1',
    targetKind: 'dav',
    remoteUrl: 'https://remote.example.com/dav',
    remoteOwner: '',
    remoteVolume: '',
    remotePath: '',
    authKind: 'none',
    mode: 'keep-both',
    intervalMinutes: 60,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    consecutiveFailures: 0,
    passInFlight: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function conflict(overrides: Partial<ReplicationConflict> = {}): ReplicationConflict {
  return {
    conflictId: 'c1',
    path: 'notes.txt',
    winner: 'remote',
    keptPath: null,
    kind: 'conflict',
    detectedAt: 1,
    resolvedAt: null,
    ...overrides,
  };
}

function renderCard(backend?: string | null) {
  const showNotice = vi.fn();
  render(<VolumeReplicationCard owner="alice" volume="photos" showNotice={showNotice} backend={backend} />);
  return { showNotice };
}

const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  listReplications.mockReset().mockResolvedValue({ supported: true, replications: [], allowedIntervals: [15, 60, 360] });
  createReplication.mockReset().mockResolvedValue(replication());
  updateReplication.mockReset().mockResolvedValue(replication());
  deleteReplication.mockReset().mockResolvedValue(undefined);
  runReplicationNow.mockReset().mockResolvedValue({ sync: 'started' });
  listReplicationConflicts.mockReset().mockResolvedValue([]);
  resolveReplicationConflict.mockReset().mockResolvedValue(true);
});

describe('replication card: version skew', () => {
  it('says the backend predates the feature instead of showing an empty target list', async () => {
    listReplications.mockResolvedValue({ supported: false });
    renderCard();
    await waitFor(() => expect(screen.getByText('This Backend Predates Replication. Update It To Configure Targets.')).toBeTruthy());
    // The add-target form is the dangerous thing to leave on screen here: it would
    // accept input and answer 404 for every submission.
    expect(screen.queryByRole('button', { name: 'Add Replication' })).toBeNull();
    expect(screen.queryByText('No Replication Targets Yet.')).toBeNull();
  });

  it('does not mistake a refusal for version skew', async () => {
    // The error type and the 404 are the same shape from the caller's side, which
    // is why skew is decided on the status alone — and why anything that is not a
    // 404 must still reach the notice bar.
    const { BackendError } = await import('../apps/web/src/lib/api');
    listReplications.mockRejectedValue(new BackendError('Forbidden', 'Forbidden', 403));
    const { showNotice } = renderCard();
    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', 'Access Denied.'));
    expect(screen.queryByText('This Backend Predates Replication. Update It To Configure Targets.')).toBeNull();
  });

  it('refetches on refresh, so a backend updated in place is not stuck on skew', async () => {
    listReplications.mockResolvedValue({ supported: false });
    renderCard();
    await waitFor(() => expect(screen.getByText('This Backend Predates Replication. Update It To Configure Targets.')).toBeTruthy());

    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(button('Sync Now')).toBeTruthy());
  });
});

describe('replication card: listing targets', () => {
  it('renders each target with the backend selector threaded through', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [15, 60, 360] });
    renderCard('office');
    await waitFor(() => expect(button('Sync Now')).toBeTruthy());
    expect(listReplications).toHaveBeenCalledWith('alice', 'photos', 'office');
    expect(screen.getByText('https://remote.example.com/dav')).toBeTruthy();
  });

  it('explains an open pass rather than leaving the owner to guess replication is broken', async () => {
    // `passInFlight` is the backend's deletion gate, so it is the reason a
    // deletion has *not* propagated. Rendering nothing here is what produces
    // "replication is broken" reports.
    listReplications.mockResolvedValue({ supported: true, replications: [replication({ passInFlight: true })], allowedIntervals: [60] });
    renderCard();
    await waitFor(() =>
      expect(
        screen.getByText('A Sync Pass Is In Progress. Deletions Propagate Only After A Pass Finishes Without Errors.'),
      ).toBeTruthy(),
    );
  });

  it('surfaces a failed run and its error text', async () => {
    listReplications.mockResolvedValue({
      supported: true,
      replications: [replication({ lastStatus: 'failed', lastError: 'remote refused 507', consecutiveFailures: 3 })],
      allowedIntervals: [60],
    });
    renderCard();
    await waitFor(() => expect(screen.getByText('Failed')).toBeTruthy());
    expect(screen.getByText('remote refused 507')).toBeTruthy();
    expect(screen.getByText('3 Consecutive Failed Attempts')).toBeTruthy();
  });

  it('shows an empty state that is not the skew notice', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('No Replication Targets Yet.')).toBeTruthy());
  });
});

describe('replication card: acting on a target', () => {
  it('reports "started" as success, because the backend answered 202 and detached the work', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    runReplicationNow.mockResolvedValue({ sync: 'started' });
    const { showNotice } = renderCard('office');
    await waitFor(() => expect(button('Sync Now')).toBeTruthy());

    fireEvent.click(button('Sync Now'));

    await waitFor(() =>
      expect(runReplicationNow).toHaveBeenCalledWith('alice', 'photos', 'r1', 'office'),
    );
    // A client timeout on this route would look like a failed sync that had in
    // fact succeeded, so "started" must read as progress, not as nothing happening.
    expect(showNotice).toHaveBeenCalledWith('success', 'Sync Started. It Continues In The Background.');
  });

  it('reports a finished slice distinctly from a started one', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    runReplicationNow.mockResolvedValue({ sync: 'done', status: 'ok' });
    const { showNotice } = renderCard();
    await waitFor(() => expect(button('Sync Now')).toBeTruthy());

    fireEvent.click(button('Sync Now'));

    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('success', 'Sync Finished.'));
  });

  it('pauses through the backend rather than tracking the flag locally', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    renderCard('office');
    await waitFor(() => expect(button('Pause')).toBeTruthy());

    fireEvent.click(button('Pause'));

    await waitFor(() => expect(updateReplication).toHaveBeenCalledWith('alice', 'photos', 'r1', { enabled: false }, 'office'));
  });

  it('offers Resume for a paused target, so the control is not a one-way door', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication({ enabled: false })], allowedIntervals: [60] });
    renderCard();
    await waitFor(() => expect(screen.getByText('Paused')).toBeTruthy());

    fireEvent.click(button('Resume'));

    await waitFor(() => expect(updateReplication).toHaveBeenCalledWith('alice', 'photos', 'r1', { enabled: true }, undefined));
  });

  it('removes a target only after confirmation, and names it', async () => {
    listReplications.mockResolvedValue({
      supported: true,
      replications: [replication({ targetKind: 'dav-volume', remoteUrl: '', remoteOwner: 'bob', remoteVolume: 'backup' })],
      allowedIntervals: [60],
    });
    renderCard('office');
    await waitFor(() => expect(screen.getByText('bob/backup')).toBeTruthy());

    fireEvent.click(button('Remove'));
    // Still present: the modal is the gate, and a target's removal drops the
    // backend's recorded base state with it.
    expect(deleteReplication).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteReplication).toHaveBeenCalledWith('alice', 'photos', 'r1', 'office'));
  });
});

describe('replication card: recorded decisions', () => {
  it('lists a propagated deletion with the side it removed from', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    listReplicationConflicts.mockResolvedValue([conflict({ kind: 'deletion', winner: 'local' })]);
    renderCard();
    await waitFor(() => expect(button('Show Decisions')).toBeTruthy());

    fireEvent.click(button('Show Decisions'));

    await waitFor(() => expect(screen.getByText('Deletion Propagated. This Bucket Side Was Removed.')).toBeTruthy());
    expect(listReplicationConflicts).toHaveBeenCalledWith('alice', 'photos', 'r1', undefined);
  });

  it('names the conflict copy, which is the only place a losing version survives', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    listReplicationConflicts.mockResolvedValue([conflict({ keptPath: 'notes.conflict-1750000000.txt' })]);
    renderCard();
    await waitFor(() => expect(button('Show Decisions')).toBeTruthy());

    fireEvent.click(button('Show Decisions'));

    await waitFor(() => expect(screen.getByText('Other Version Kept At: notes.conflict-1750000000.txt')).toBeTruthy());
  });

  it('resolves against the target the decisions were opened for', async () => {
    // The conflict projection carries no `replicationId`, so the pair has to come
    // from which target was expanded. Inferring it from list order would send a
    // resolve to the wrong target's audit trail.
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    listReplicationConflicts.mockResolvedValue([conflict()]);
    renderCard('office');
    await waitFor(() => expect(button('Show Decisions')).toBeTruthy());

    fireEvent.click(button('Show Decisions'));
    await waitFor(() => expect(button('Mark Resolved')).toBeTruthy());
    fireEvent.click(button('Mark Resolved'));

    await waitFor(() => expect(resolveReplicationConflict).toHaveBeenCalledWith('alice', 'photos', 'r1', 'c1', 'office'));
  });

  it('keeps the decision visible when resolving fails, so it can be retried', async () => {
    // It vanishes on success and persists on error. A row that disappeared on a
    // failed resolve would lose sight of a decision still needing an answer.
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    listReplicationConflicts.mockResolvedValue([conflict()]);
    resolveReplicationConflict.mockRejectedValue(new Error('nope'));
    const { showNotice } = renderCard();
    await waitFor(() => expect(button('Show Decisions')).toBeTruthy());

    fireEvent.click(button('Show Decisions'));
    await waitFor(() => expect(button('Mark Resolved')).toBeTruthy());
    fireEvent.click(button('Mark Resolved'));

    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', 'Failed To Mark Resolved.'));
    expect(button('Mark Resolved')).toBeTruthy();
  });

  it('closes the panel and reports the failure when the decision list will not load', async () => {
    // The panel must not stay up showing an empty list: that reads as "nothing to
    // reconcile", which is a claim about the target's audit trail that was never
    // verified. It closes, the target list survives, and the failure is reported
    // rather than swallowed.
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    listReplicationConflicts.mockRejectedValue(new Error('nope'));
    const { showNotice } = renderCard();
    await waitFor(() => expect(button('Show Decisions')).toBeTruthy());

    fireEvent.click(button('Show Decisions'));

    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', 'Failed To Load Decisions.'));
    expect(screen.queryByText('Nothing To Reconcile.')).toBeNull();
    expect(screen.queryByText('Recorded Decisions')).toBeNull();
    expect(button('Sync Now')).toBeTruthy();
  });

  it('shows the empty state when the target genuinely has no decisions', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [replication()], allowedIntervals: [60] });
    listReplicationConflicts.mockResolvedValue([]);
    renderCard();
    await waitFor(() => expect(button('Show Decisions')).toBeTruthy());

    fireEvent.click(button('Show Decisions'));

    await waitFor(() => expect(screen.getByText('Nothing To Reconcile.')).toBeTruthy());
    expect(button('Sync Now')).toBeTruthy();
  });
});

describe('replication card: adding a target', () => {
  it('sends the selector and the sibling-bucket fields for a bucket on this server', async () => {
    renderCard('office');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Replication' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Target Type'), { target: { value: 'dav-volume' } });
    fireEvent.change(screen.getByLabelText('Bucket Owner'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByLabelText('Bucket Name'), { target: { value: 'backup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Replication' }));

    await waitFor(() => expect(createReplication).toHaveBeenCalled());
    const [owner, volume, input, backend] = createReplication.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect([owner, volume, backend]).toEqual(['alice', 'photos', 'office']);
    expect(input['targetKind']).toBe('dav-volume');
    expect(input['remoteOwner']).toBe('bob');
    expect(input['remoteVolume']).toBe('backup');
    // A sibling target is reached over the backend's own RPC, so it carries no
    // URL and no credential — sending empty strings is what keeps the backend
    // from treating it as an HTTP remote.
    expect(input['remoteUrl']).toBe('');
    expect(input['authKind']).toBe('none');
  });

  it('does not render the external-server fields for a bucket target', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByLabelText('Server URL')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Target Type'), { target: { value: 'dav-volume' } });

    expect(screen.queryByLabelText('Server URL')).toBeNull();
    expect(screen.queryByLabelText('Authentication')).toBeNull();
  });

  it('offers the backend\'s own intervals rather than the local fallback list', async () => {
    listReplications.mockResolvedValue({ supported: true, replications: [], allowedIntervals: [360, 1440] });
    renderCard();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Replication' })).toBeTruthy());

    const options = [...screen.getByLabelText('Interval').querySelectorAll('option')].map((o) => o.textContent);
    // The local constant includes 15 and 60; a backend that offers neither must
    // not be offered one it will reject with a 400.
    expect(options).toEqual(['360', '1440']);
  });

  it('reports the backend\'s own rejection message category', async () => {
    const { BackendError } = await import('../apps/web/src/lib/api');
    createReplication.mockRejectedValue(new BackendError('must use https', 'BadRequest', 400));
    const { showNotice } = renderCard();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Replication' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Add Replication' }));

    await waitFor(() => expect(showNotice).toHaveBeenCalledWith('error', 'Bad Request.'));
  });
});