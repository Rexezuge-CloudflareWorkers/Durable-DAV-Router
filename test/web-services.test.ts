import { describe, expect, it, vi } from 'vitest';
import { createBackend, deleteBackend, getBackendIdentity, listBackends, probeBackend, updateBackend } from '../apps/web/src/services/backendService';
import {
  createBucketCredential,
  listBucketCredentials,
  revokeBucketCredential,
  setBucketCredentialReadOnly,
} from '../apps/web/src/services/credentialService';
import { loadCurrentUser } from '../apps/web/src/services/userService';
import {
  createReplication,
  deleteReplication,
  intervalLabel,
  listReplicationConflicts,
  listReplications,
  REPLICATION_INTERVALS,
  resolveReplicationConflict,
  runReplicationNow,
  targetLabel,
  updateReplication,
} from '../apps/web/src/services/replicationService';
import { deleteVolume, listMyVolumes, loadVolume, updateVolume } from '../apps/web/src/services/volumeService';
import type { BucketReplication } from '../apps/web/src/types';

/**
 * The API service layer, and specifically the `?backend=` selector.
 *
 * The router fronts several backends, so every one of these calls carries an
 * optional upstream selector. That was implemented five ways across four files — a
 * `withBackend` param map, a `withBackendQuery` string helper, a `credentialBase`
 * that inlined the query, a bare template literal in `updateVolume`/`deleteVolume`,
 * and `davClient`'s own — which is now one `lib/backendSelector`. Each service is
 * still asserted individually, because the property that matters is not "one
 * helper exists" but "every service puts the selector on every request": a
 * dropped selector silently targets the wrong backend, or none.
 */

interface Call {
  url: string;
  init: RequestInit;
}

/**
Run `body` with `fetch` stubbed, returning the result and every request made.
`vi.stubGlobal`/`vi.unstubAllGlobals` is used rather than a hand-rolled
save/restore so an exception mid-test cannot leak the stub into the next one.
*/
async function withFetch<T>(body: string, run: () => Promise<T>, status = 200): Promise<{ result: T; calls: Call[] }> {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body, { status });
    },
  );
  try {
    return { result: await run(), calls };
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * The JSON body a recorded call sent.
 *
 * `apiPost` in `lib/api` stringifies before handing the body to `fetch`, so the
 * recorded `BodyInit` is expected to be a string. Asserting that rather than
 * coercing it keeps a change in the API layer from silently altering these
 * expectations.
 */
async function recordedJson(call: Call | undefined): Promise<unknown> {
  const body = call?.init.body;
  if (typeof body !== 'string') throw new Error(`expected a string request body, received ${typeof body}`);
  return JSON.parse(body);
}

const only = (calls: Call[]): Call => {
  const first = calls[0];
  if (!first) throw new Error('no request was made');
  return first;
};

/**
Path + query of a request target, so selector placement is visible.
*/
function target(url: string): string {
  return new URL(url, 'https://router.example.com').pathname + new URL(url, 'https://router.example.com').search;
}

describe('backendService', () => {
  it('lists backends and defaults a missing array to empty', async () => {
    const { result, calls } = await withFetch('{"backends":[{"slug":"office"}]}', () => listBackends());
    expect(only(calls).url).toBe('/user/backends');
    expect(result).toEqual([{ slug: 'office' }]);

    const empty = await withFetch('{}', () => listBackends());
    expect(empty.result).toEqual([]);
  });

  it('creates, updates and deletes, encoding the slug', async () => {
    const created = await withFetch('{"slug":"a b"}', () => createBackend({ slug: 'a b', baseUrl: 'https://dav.example.com' }));
    expect(only(created.calls).url).toBe('/user/backends');
    expect(created.calls[0]?.init.method).toBe('POST');
    expect(await recordedJson(created.calls[0])).toEqual({ slug: 'a b', baseUrl: 'https://dav.example.com' });

    const updated = await withFetch('{"slug":"office"}', () => updateBackend('a b', { displayName: 'Office' }));
    expect(target(only(updated.calls).url)).toBe('/user/backends/a%20b');
    expect(updated.calls[0]?.init.method).toBe('PATCH');

    const deleted = await withFetch('{"ok":true}', () => deleteBackend('a b'));
    expect(target(only(deleted.calls).url)).toBe('/user/backends/a%20b');
    expect(deleted.calls[0]?.init.method).toBe('DELETE');
  });

  it('probes and reads identity under the slug', async () => {
    const probe = await withFetch('{"slug":"office"}', () => probeBackend('office'));
    expect(target(only(probe.calls).url)).toBe('/user/backends/office/probe');

    const me = await withFetch('{"slug":"office","username":null}', () => getBackendIdentity('office'));
    expect(target(only(me.calls).url)).toBe('/user/backends/office/me');
    expect(me.result).toEqual({ slug: 'office', username: null });
  });
});

describe('credentialService', () => {
  const owner = 'test';
  const volume = 'my bucket';
  const base = `/user/volumes/${owner}/${encodeURIComponent(volume)}/credentials`;

  it('lists credentials and defaults a missing array to empty', async () => {
    const { result, calls } = await withFetch('{"credentials":[{"credential_id":"c1"}]}', () => listBucketCredentials(owner, volume));
    expect(only(calls).url).toBe(base);
    expect(result).toEqual([{ credential_id: 'c1' }]);

    const empty = await withFetch('{}', () => listBucketCredentials(owner, volume));
    expect(empty.result).toEqual([]);
  });

  it('appends the selector to the list and create URLs', async () => {
    const listed = await withFetch('{}', () => listBucketCredentials(owner, volume, 'office'));
    expect(target(only(listed.calls).url)).toBe(`${base}?backend=office`);

    const created = await withFetch('{"credential_id":"c1"}', () => createBucketCredential(owner, volume, 'laptop', 30, false, 'office'));
    expect(target(only(created.calls).url)).toBe(`${base}?backend=office`);
    expect(await recordedJson(created.calls[0])).toEqual({ name: 'laptop', expiresInDays: 30, readOnly: false });
  });

  it('sends the read-only flag on create without disturbing the selector', async () => {
    // `readOnly` precedes `backend` positionally. Had it been appended after the
    // selector, a caller's `true` would land in `backend` and become
    // `?backend=true` — a bucket that does not exist, reported as a 404 rather
    // than as the access level the owner asked for.
    const created = await withFetch('{"credential_id":"c1","readOnly":true}', () =>
      createBucketCredential(owner, volume, 'backup', undefined, true, 'office'),
    );
    expect(target(only(created.calls).url)).toBe(`${base}?backend=office`);
    expect(await recordedJson(created.calls[0])).toEqual({ name: 'backup', expiresInDays: undefined, readOnly: true });
  });

  it('flips the flag with PATCH, keeping the selector as the only query', async () => {
    const flipped = await withFetch('{"credentialId":"c 1","readOnly":true}', () =>
      setBucketCredentialReadOnly(owner, volume, 'c 1', true, 'office'),
    );
    expect(target(only(flipped.calls).url)).toBe(`${base}/${encodeURIComponent('c 1')}?backend=office`);
    expect(flipped.calls[0]?.init.method).toBe('PATCH');
    expect(await recordedJson(flipped.calls[0])).toEqual({ readOnly: true });
  });

  it('flips the flag back without a selector when no backend is given', async () => {
    // The other direction matters as much: a flag that could only be set one way
    // would leave the owner holding a credential they can never restore.
    const flipped = await withFetch('{"credentialId":"c1","readOnly":false}', () =>
      setBucketCredentialReadOnly(owner, volume, 'c1', false),
    );
    expect(only(flipped.calls).url).toBe(`${base}/c1`);
    expect(await recordedJson(flipped.calls[0])).toEqual({ readOnly: false });
  });

  it('omits the selector when no backend is given', async () => {
    const listed = await withFetch('{}', () => listBucketCredentials(owner, volume, null));
    expect(target(only(listed.calls).url)).toBe(base);
  });

  it('revokes by credential id, keeping the selector as the only query', async () => {
    const revoked = await withFetch('{"ok":true}', () => revokeBucketCredential(owner, volume, 'c 1', 'office'));
    expect(target(only(revoked.calls).url)).toBe(`${base}/${encodeURIComponent('c 1')}?backend=office`);
    expect(revoked.calls[0]?.init.method).toBe('DELETE');
  });
});

describe('replicationService', () => {
  const owner = 'test';
  const volume = 'my bucket';
  const base = `/user/volumes/${owner}/${encodeURIComponent(volume)}/replications`;

  const replication = (over: Partial<BucketReplication> = {}): BucketReplication => ({
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
    ...over,
  });

  it('reports the backend\'s targets and its allowed intervals', async () => {
    const { result, calls } = await withFetch(
      '{"replications":[{"replicationId":"r1"}],"allowedIntervals":[60,360]}',
      () => listReplications(owner, volume),
    );
    expect(only(calls).url).toBe(base);
    expect(result.supported).toBe(true);
    if (!result.supported) throw new Error('expected a supported result');
    expect(result.replications).toEqual([{ replicationId: 'r1' }]);
    expect(result.allowedIntervals).toEqual([60, 360]);
  });

  it('defaults a missing array to empty and a missing interval list to the local copy', async () => {
    const { result } = await withFetch('{}', () => listReplications(owner, volume));
    if (!result.supported) throw new Error('expected a supported result');
    expect(result.replications).toEqual([]);
    // The local list is a rendering fallback for the first paint only; the backend
    // stays the enforcement point for what it will accept.
    expect(result.allowedIntervals).toEqual([...REPLICATION_INTERVALS]);
  });

  it('reads a 404 as "this backend predates replication", not as a failure', async () => {
    // The whole point of the union. A 404 here is version skew, and it must not
    // reach the error path — the notice bar would show a fault where the truth is
    // that the backend has no such route.
    const { result } = await withFetch(
      '{"Exception":{"Type":"NotFound","Message":"Volume not found"}}',
      () => listReplications(owner, volume),
      404,
    );
    expect(result).toEqual({ supported: false });
  });

  it('still throws for anything that is not a 404', async () => {
    // A 403 is the backend refusing, and a 500 is an outage. Both must surface as
    // errors: collapsing them into "unsupported" would tell an owner their backend
    // is old when it is refusing them.
    for (const status of [401, 403, 409, 500, 502]) {
      await expect(
        withFetch('{"Exception":{"Type":"InternalServerError","Message":"boom"}}', () => listReplications(owner, volume), status),
      ).rejects.toThrow();
    }
  });

  it('creates with the selector, and sends the body the backend validates', async () => {
    const { result, calls } = await withFetch('{"replication":{"replicationId":"r1"}}', () =>
      createReplication(
        owner,
        volume,
        {
          targetKind: 'dav',
          remoteUrl: 'https://remote.example.com/dav',
          authKind: 'basic',
          username: 'me',
          secret: 'hunter2',
          mode: 'sync',
          intervalMinutes: 360,
        },
        'office',
      ),
    );
    expect(target(only(calls).url)).toBe(`${base}?backend=office`);
    expect(only(calls).init.method).toBe('POST');
    expect(await recordedJson(only(calls))).toEqual({
      targetKind: 'dav',
      remoteUrl: 'https://remote.example.com/dav',
      authKind: 'basic',
      username: 'me',
      secret: 'hunter2',
      mode: 'sync',
      intervalMinutes: 360,
    });
    expect(result.replicationId).toBe('r1');
  });

  it('patches, runs, lists conflicts and resolves under the one selector', async () => {
    const patched = await withFetch('{"replication":{"replicationId":"r 1"}}', () =>
      updateReplication(owner, volume, 'r 1', { enabled: false }, 'office'),
    );
    expect(target(only(patched.calls).url)).toBe(`${base}/${encodeURIComponent('r 1')}?backend=office`);
    expect(only(patched.calls).init.method).toBe('PATCH');
    expect(await recordedJson(only(patched.calls))).toEqual({ enabled: false });

    // `run` returns 202 with the work in `waitUntil`; the router forwards the
    // status unreshaped, so `started` reaches the client rather than a timeout.
    const run = await withFetch('{"sync":"started"}', () => runReplicationNow(owner, volume, 'r1', 'office'), 202);
    expect(target(only(run.calls).url)).toBe(`${base}/r1/run?backend=office`);
    expect(only(run.calls).init.method).toBe('POST');
    expect(run.result.sync).toBe('started');

    const conflicts = await withFetch('{"conflicts":[{"conflictId":"c1"}]}', () =>
      listReplicationConflicts(owner, volume, 'r 1', 'office'),
    );
    expect(target(only(conflicts.calls).url)).toBe(`${base}/${encodeURIComponent('r 1')}/conflicts?backend=office`);
    expect(conflicts.result).toEqual([{ conflictId: 'c1' }]);

    const resolved = await withFetch('{"resolved":true}', () =>
      resolveReplicationConflict(owner, volume, 'r 1', 'c 1', 'office'),
    );
    expect(target(only(resolved.calls).url)).toBe(
      `${base}/${encodeURIComponent('r 1')}/conflicts/${encodeURIComponent('c 1')}/resolve?backend=office`,
    );
    expect(only(resolved.calls).init.method).toBe('POST');
    expect(resolved.result).toBe(true);
  });

  it('deletes by id and defaults a missing conflict array to empty', async () => {
    const deleted = await withFetch('{"ok":true}', () => deleteReplication(owner, volume, 'r1', 'office'));
    expect(target(only(deleted.calls).url)).toBe(`${base}/r1?backend=office`);
    expect(only(deleted.calls).init.method).toBe('DELETE');

    const empty = await withFetch('{}', () => listReplicationConflicts(owner, volume, 'r1'));
    expect(empty.result).toEqual([]);
  });

  it('never lets the selector become a path segment', async () => {
    // The regression shape for this whole service: a slug containing a slash, left
    // unencoded, would append a segment and address a different resource — a 404
    // that reads as a missing bucket.
    const { calls } = await withFetch('{}', () => listReplications(owner, volume, 'a b/c'));
    expect(new URL(only(calls).url, 'https://router.example.com').pathname).toBe(base);
  });

  it('renders an interval and a target label from the fields the backend sent', () => {
    expect(intervalLabel(15)).toBe('15m');
    expect(intervalLabel(60)).toBe('1h');
    expect(intervalLabel(90)).toBe('1.5h');
    expect(intervalLabel(1440)).toBe('1d');
    expect(intervalLabel(10_080)).toBe('7d');

    expect(targetLabel(replication())).toBe('https://remote.example.com/dav');
    expect(targetLabel(replication({ remotePath: 'backups/bucket' }))).toBe('https://remote.example.com/dav/backups/bucket');
    // A sibling bucket's "URL" is its owner/volume path — the URL column is empty
    // for that kind, so rendering it would show the user a blank target.
    expect(targetLabel(replication({ targetKind: 'dav-volume', remoteUrl: '', remoteOwner: 'alice', remoteVolume: 'photos' }))).toBe(
      'alice/photos',
    );
    expect(
      targetLabel(replication({ targetKind: 'dav-volume', remoteUrl: '', remoteOwner: 'alice', remoteVolume: 'photos', remotePath: 'sub' })),
    ).toBe('alice/photos/sub');
  });
});

describe('volumeService', () => {
  it('lists volumes and backends, defaulting both to empty', async () => {
    const { result, calls } = await withFetch('{"volumes":[{"name":"photos"}],"backends":[{"slug":"office"}]}', () => listMyVolumes());
    expect(only(calls).url).toBe('/user/volumes');
    expect(result.volumes).toHaveLength(1);
    expect(result.backends).toHaveLength(1);

    const empty = await withFetch('{}', () => listMyVolumes());
    expect(empty.result).toEqual({ volumes: [], backends: [] });
  });

  it('passes the selector as a query param when listing', async () => {
    const { calls } = await withFetch('{}', () => listMyVolumes('office'));
    expect(target(only(calls).url)).toBe('/user/volumes?backend=office');
  });

  it('derives fullName when loading a volume', async () => {
    const { result, calls } = await withFetch(
      '{"owner":"test","name":"photos","description":"d","isPrivate":true,"href":"/test/photos/"}',
      () => loadVolume('test', 'photos'),
    );
    expect(target(only(calls).url)).toBe('/user/volumes/test/photos');
    expect(result.fullName).toBe('test/photos');
    expect(result.description).toBe('d');
    expect(result.isPrivate).toBe(true);
  });

  it('keeps the selector last on a PATCH', async () => {
    const { calls } = await withFetch(
      '{"owner":"test","name":"photos","description":null,"isPrivate":false,"href":"/test/photos/"}',
      () => updateVolume('test', 'photos', { isPrivate: false }, 'office'),
    );
    expect(target(only(calls).url)).toBe('/user/volumes/test/photos?backend=office');
    expect(only(calls).init.method).toBe('PATCH');
  });

  it('deletes with and without the selector', async () => {
    const withSelector = await withFetch('{"ok":true}', () => deleteVolume('test', 'photos', 'office'));
    expect(target(only(withSelector.calls).url)).toBe('/user/volumes/test/photos?backend=office');
    expect(only(withSelector.calls).init.method).toBe('DELETE');

    const without = await withFetch('{"ok":true}', () => deleteVolume('test', 'photos'));
    expect(target(only(without.calls).url)).toBe('/user/volumes/test/photos');
  });

  it('encodes a volume name that needs it', async () => {
    const { calls } = await withFetch('{"ok":true}', () => deleteVolume('test', 'my bucket'));
    expect(target(only(calls).url)).toBe(`/user/volumes/test/${encodeURIComponent('my bucket')}`);
  });
});

describe('userService', () => {
  it('issues one GET /user/me for concurrent mounts', async () => {
    // StrictMode double-mounts effects; the inflight holder must collapse them
    // into a single request rather than two.
    const { result, calls } = await withFetch('{"email":"a@b.c"}', async () => {
      const [first, second] = await Promise.all([loadCurrentUser(), loadCurrentUser()]);
      expect(first).toBe(second);
      return first;
    });
    expect(calls).toHaveLength(1);
    expect(only(calls).url).toBe('/user/me');
    // The router is email-only: usernames live per-backend, not on the session.
    expect(result.email).toBe('a@b.c');
  });

  it('refetches after the inflight request settles', async () => {
    await withFetch('{"email":"a@b.c"}', () => loadCurrentUser());
    const second = await withFetch('{"email":"a@b.c"}', () => loadCurrentUser());
    expect(second.calls).toHaveLength(1);
  });
});

describe('the ?backend= selector, as a contract rather than as five shapes', () => {
  /**
   * One rule, asserted through every service that carries it.
   *
   * Previously each service's *particular* string-building shape was pinned, which
   * meant unifying them was a test-rewrite rather than a change with a stated
   * invariant. These assert the invariant instead: the selector is present exactly
   * once, correctly encoded, and absent — not empty, not `?backend=` — when the
   * caller named no backend.
   */
  const SLUG = 'my backend/v2';

  function selectorsOf(url: string): string[] {
    return [...new URL(url, 'https://router.example.com').searchParams.getAll('backend')];
  }

  it('every service emits exactly one correctly-encoded selector', async () => {
    const services: Array<[string, () => Promise<unknown>]> = [
      ['listMyVolumes', () => listMyVolumes(SLUG)],
      ['loadVolume', () => loadVolume('test', 'photos', SLUG)],
      ['updateVolume', () => updateVolume('test', 'photos', { description: 'x' }, SLUG)],
      ['deleteVolume', () => deleteVolume('test', 'photos', SLUG)],
      ['listBucketCredentials', () => listBucketCredentials('test', 'photos', SLUG)],
      ['createBucketCredential', () => createBucketCredential('test', 'photos', 'c', 30, true, SLUG)],
      ['setBucketCredentialReadOnly', () => setBucketCredentialReadOnly('test', 'photos', 'cred 1', true, SLUG)],
      ['revokeBucketCredential', () => revokeBucketCredential('test', 'photos', 'cred 1', SLUG)],
      ['listReplications', () => listReplications('test', 'photos', SLUG)],
      ['createReplication', () =>
        createReplication(
          'test',
          'photos',
          { targetKind: 'dav', authKind: 'none', mode: 'sync', intervalMinutes: 60 },
          SLUG,
        )],
      ['updateReplication', () => updateReplication('test', 'photos', 'r1', { enabled: false }, SLUG)],
      ['deleteReplication', () => deleteReplication('test', 'photos', 'r1', SLUG)],
      ['runReplicationNow', () => runReplicationNow('test', 'photos', 'r1', SLUG)],
      ['listReplicationConflicts', () => listReplicationConflicts('test', 'photos', 'r1', SLUG)],
      ['resolveReplicationConflict', () => resolveReplicationConflict('test', 'photos', 'r1', 'c1', SLUG)],
    ];
    for (const [name, call] of services) {
      const { calls } = await withFetch('{"ok":true,"credentials":[],"volumes":[],"backends":[]}', call);
      expect(selectorsOf(only(calls).url), name).toEqual([SLUG]);
    }
  });

  it('emits no query at all when no backend was named', async () => {
    // `?backend=` with an empty value is not the same as no selector: it resolves
    // to no backend and 404s the request, which reads to the user as a missing
    // bucket rather than as a wrong argument.
    const services: Array<[string, () => Promise<unknown>]> = [
      ['listMyVolumes', () => listMyVolumes()],
      ['loadVolume', () => loadVolume('test', 'photos')],
      ['updateVolume', () => updateVolume('test', 'photos', { description: 'x' })],
      ['deleteVolume', () => deleteVolume('test', 'photos')],
      ['listBucketCredentials', () => listBucketCredentials('test', 'photos')],
      ['createBucketCredential', () => createBucketCredential('test', 'photos', 'c')],
      ['setBucketCredentialReadOnly', () => setBucketCredentialReadOnly('test', 'photos', 'c', false)],
      ['revokeBucketCredential', () => revokeBucketCredential('test', 'photos', 'c')],
      ['listReplications', () => listReplications('test', 'photos')],
      ['createReplication', () =>
        createReplication('test', 'photos', { targetKind: 'dav', authKind: 'none', mode: 'sync', intervalMinutes: 60 })],
      ['updateReplication', () => updateReplication('test', 'photos', 'r1', { enabled: false })],
      ['deleteReplication', () => deleteReplication('test', 'photos', 'r1')],
      ['runReplicationNow', () => runReplicationNow('test', 'photos', 'r1')],
      ['listReplicationConflicts', () => listReplicationConflicts('test', 'photos', 'r1')],
      ['resolveReplicationConflict', () => resolveReplicationConflict('test', 'photos', 'r1', 'c1')],
    ];
    for (const [name, call] of services) {
      const { calls } = await withFetch('{"ok":true,"credentials":[],"volumes":[],"backends":[]}', call);
      expect(new URL(only(calls).url, 'https://router.example.com').search, name).toBe('');
    }
  });

  it('treats an empty or absent selector identically', async () => {
    for (const value of ['', null, undefined]) {
      const { calls } = await withFetch('{"ok":true}', () => deleteVolume('test', 'photos', value));
      expect(new URL(only(calls).url, 'https://router.example.com').search).toBe('');
    }
  });
});
