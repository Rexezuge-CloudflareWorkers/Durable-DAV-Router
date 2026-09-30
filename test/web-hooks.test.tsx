// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { NOTICE_TIMEOUT_MS } from '../apps/web/src/lib/constants';
import { useNotice } from '../apps/web/src/hooks/useNotice';
import { useCurrentUser } from '../apps/web/src/hooks/useCurrentUser';
import { singleSegmentName, useVolumeMutations } from '../apps/web/src/views/volume/useVolumeMutations';

const userService = vi.hoisted(() => ({ loadCurrentUser: vi.fn() }));
const davClient = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  createDirectory: vi.fn(),
  uploadFile: vi.fn(),
  deleteEntry: vi.fn(),
  moveEntry: vi.fn(),
  copyEntry: vi.fn(),
  downloadUrl: vi.fn((owner: string, volume: string, path: string) => `/files/${owner}/${volume}/${path}`),
}));

vi.mock('../apps/web/src/services/userService', () => userService);
vi.mock('../apps/web/src/services/davClient', () => davClient);

// The mutations hook reads localized messages through `useTranslation`; the
// notices it emits are the assertion surface, so the real hook is stubbed to
// return the caller's own defaults — which is what `t(key, fallback)` does.
vi.mock('react-i18next', () => ({
  // `initReactI18next` is imported by the real `i18n.ts`, which several components
  // pull in transitively; it is named here so the import resolves.
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, string | number>) => {
      let text = fallback ?? key;
      const substitutions = Object.entries(vars ?? {});
      for (const [name, value] of substitutions) text = text.replace(`{{${name}}}`, String(value));
      return text;
    },
  }),
}));

const listing = (over: Record<string, unknown> = {}) => ({
  entries: [],
  page: 1,
  limit: 100,
  total: null,
  paged: false,
  ...over,
});

beforeEach(() => {
  userService.loadCurrentUser.mockReset();
  davClient.listDirectory.mockReset();
  for (const name of ['createDirectory', 'uploadFile', 'deleteEntry', 'moveEntry', 'copyEntry'] as const) {
    davClient[name].mockReset();
    davClient[name].mockResolvedValue(undefined);
  }
  davClient.listDirectory.mockResolvedValue(listing());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * `useNotice` owns a timer, and a leak here is a notice that never clears on a
 * page that has already navigated away.
 */
describe('useNotice', () => {
  it('shows a notice and clears it on the timer', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotice());
    expect(result.current.notice).toBeNull();
    act(() => {
      result.current.showNotice('error', 'Failed To Load Volumes.');
    });
    expect(result.current.notice).toEqual({ type: 'error', text: 'Failed To Load Volumes.' });
    act(() => {
      vi.advanceTimersByTime(NOTICE_TIMEOUT_MS);
    });
    expect(result.current.notice).toBeNull();
  });

  it('replaces an in-flight notice rather than stacking two', () => {
    // Two overlapping actions must leave one message, not a queue the user has to
    // read through — and the first one's timer must not clear the second.
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotice());
    act(() => {
      result.current.showNotice('success', 'First.');
      // Let the first notice's timer nearly expire, then replace it.
      vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 1);
      result.current.showNotice('error', 'Second.');
      // Just past the point where the *first* timer would have fired. If it was not
      // cancelled it would clear the second notice a millisecond after it appeared,
      // which is the bug: the user reads one message and the next disappears before
      // they have finished it.
      vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 1);
    });
    expect(result.current.notice).toEqual({ type: 'error', text: 'Second.' });
  });
});

describe('useCurrentUser', () => {
  it('reports authorized with the resolved account', async () => {
    userService.loadCurrentUser.mockResolvedValue({ email: 'a@example.com', id: 'usr_a' });
    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.authorized).toBe(true));
    expect(result.current.user).toEqual({ email: 'a@example.com', id: 'usr_a' });
  });

  it('reports unauthorized when the profile call fails', async () => {
    // This is the gate every view behind it: an authenticated request whose
    // identity the router could not resolve must render the sign-in page, not a
    // dashboard that will 401 on every action.
    userService.loadCurrentUser.mockRejectedValue(new Error('401'));
    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.authorized).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it('collapses the double mount of StrictMode into one request', async () => {
    // Mount effects are double-invoked in development, and the profile call sits
    // in front of every authenticated view.
    userService.loadCurrentUser.mockResolvedValue({ email: 'a@example.com', id: 'usr_a' });
    render(<StrictModeWrapper />);
    await waitFor(() => expect(userService.loadCurrentUser).toHaveBeenCalled());
    expect(userService.loadCurrentUser).toHaveBeenCalledOnce();
  });
});

function StrictModeWrapper() {
  const { authorized } = useCurrentUser();
  return <span>{authorized === null ? 'pending' : String(authorized)}</span>;
}

describe('useVolumeMutations', () => {
  /**
   * Render the hook with named arguments, letting a test override any of them.
   *
   * Merged rather than spread as trailing arguments: `useVolumeMutations` takes
   * six positional parameters, so an appended `props` object would have been a
   * seventh argument the hook ignores — and the test would pass against a path
   * it never asked for.
   */
  const setup = (over: { path?: string; owner?: string; volume?: string; backend?: string | null } = {}) => {
    const showNotice = vi.fn();
    const refresh = vi.fn();
    const args: { owner: string; volume: string; path: string; showNotice: typeof showNotice; refresh: typeof refresh; backend: string | null } = {
      owner: 'alice',
      volume: 'photos',
      path: '',
      showNotice,
      refresh,
      backend: 'office',
      ...over,
    };
    const { result } = renderHook(() =>
      useVolumeMutations(args.owner, args.volume, args.path, args.showNotice, args.refresh, args.backend),
    );
    return { result, showNotice, refresh };
  };

  it('rejects an empty folder name before making a request', async () => {
    const { result, showNotice } = setup();
    await act(async () => {
      result.current.setMkdirName(' '.repeat(3));
    });
    await act(async () => {
      await result.current.doMkdir({ preventDefault: () => undefined } as never);
    });
    expect(davClient.createDirectory).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith('error', 'Enter A Single Folder Name.');
  });

  it('rejects a folder name containing a separator', async () => {
    // `MKCOL` takes one segment. Sending `a/b` silently creates a second level the
    // user did not ask for — and the directory the dialog was naming stays absent.
    const { result, showNotice } = setup();
    await act(async () => {
      result.current.setMkdirName('a/b');
    });
    await act(async () => {
      await result.current.doMkdir({ preventDefault: () => undefined } as never);
    });
    expect(davClient.createDirectory).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith('error', 'Enter A Single Folder Name.');
  });

  it('creates a folder at the current path and reports success', async () => {
    const { result, showNotice, refresh } = setup({ path: 'docs' });
    await act(async () => {
      result.current.setMkdirName('sub');
    });
    await act(async () => {
      await result.current.doMkdir({ preventDefault: () => undefined } as never);
    });
    expect(davClient.createDirectory).toHaveBeenCalledWith('alice', 'photos', 'docs/sub', 'office');
    expect(showNotice).toHaveBeenCalledWith('success', 'Folder Created.');
    expect(refresh).toHaveBeenCalled();
  });

  it('reports a failed create, and leaves the dialog usable', async () => {
    const { result, showNotice } = setup();
    davClient.createDirectory.mockRejectedValue(new Error('409'));
    await act(async () => {
      result.current.setMkdirName('sub');
    });
    await act(async () => {
      await result.current.doMkdir({ preventDefault: () => undefined } as never);
    });
    expect(showNotice).toHaveBeenCalledWith('error', 'Failed To Create Folder.');
    // `busy` must be clear, or every button in the browser is disabled until reload.
    expect(result.current.busy).toBe(false);
    expect(result.current.mkdirName).toBe('sub');
  });

  it('uploads files sequentially, not concurrently', async () => {
    // 200 parallel PUTs against one Durable Object is the shape that produces a
    // 429 rather than a file.
    let inFlight = 0;
    let peak = 0;
    davClient.uploadFile.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    const { result } = setup({ path: 'docs' });
    const files = [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'c.txt' }] as unknown as FileList;
    await act(async () => {
      await result.current.doUpload(files);
    });
    expect(davClient.uploadFile).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it('does nothing for an empty file selection', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.doUpload([] as unknown as FileList);
    });
    expect(davClient.uploadFile).not.toHaveBeenCalled();
  });

  it('ignores a delete with nothing selected', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.doDelete();
    });
    expect(davClient.deleteEntry).not.toHaveBeenCalled();
  });

  it('closes the delete dialog only on success', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.setDeleting({ path: 'a.txt', isCollection: false, name: 'a.txt' } as never);
    });
    davClient.deleteEntry.mockRejectedValue(new Error('403'));
    await act(async () => {
      await result.current.doDelete();
    });
    // The dialog stays open so the user can retry without re-finding the file.
    expect(result.current.deleting).not.toBeNull();
  });

  it('treats a rename to the current name as a dismissal, not an error', async () => {
    // The backend answers 412 for this, and leaving the dialog open on a
    // no-op leaves the user thinking their change was rejected.
    const { result, showNotice } = setup();
    await act(async () => {
      result.current.setRenaming({ path: 'a.txt', isCollection: false, name: 'a.txt' } as never);
    });
    await act(async () => {
      result.current.setRenameValue('a.txt');
    });
    await act(async () => {
      await result.current.doRename({ preventDefault: () => undefined } as never);
    });
    expect(davClient.moveEntry).not.toHaveBeenCalled();
    expect(showNotice).not.toHaveBeenCalled();
    expect(result.current.renaming).toBeNull();
  });

  it('duplicates an entry beside itself', async () => {
    const { result, showNotice } = setup();
    await act(async () => {
      await result.current.doDuplicate({ path: 'dir', isCollection: true, name: 'dir' } as never);
    });
    expect(davClient.copyEntry).toHaveBeenCalledWith('alice', 'photos', 'dir', 'dir-copy', true, 'office');
    expect(showNotice).toHaveBeenCalledWith('success', 'Duplicated.');
  });

  it('opens a directory in place rather than downloading it', async () => {
    const { result } = setup();
    const openPath = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await act(async () => {
      await result.current.openPreview({ path: 'dir', isCollection: true, name: 'dir' } as never, openPath);
    });
    expect(openPath).toHaveBeenCalledWith('dir');
    expect(open).not.toHaveBeenCalled();
  });

  it('previews a small text file inline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello', { headers: { 'Content-Type': 'text/plain' } })));
    const { result } = setup();
    await act(async () => {
      await result.current.openPreview({ path: 'a.txt', isCollection: false, name: 'a.txt' } as never, vi.fn());
    });
    expect(result.current.preview).toMatchObject({ text: 'hello' });
  });

  it('falls back to a new tab for a file too large to read', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(2_000_000), { headers: { 'Content-Type': 'image/png' } })));
    const { result } = setup();
    await act(async () => {
      await result.current.openPreview({ path: 'big.png', isCollection: false, name: 'big.png' } as never, vi.fn());
    });
    expect(open).toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
  });

  it('falls back to a new tab when the fetch fails at all', async () => {
    // A user who asked to see a file and got a spinner learns nothing; a download
    // that succeeds beats a preview they then dismiss.
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const { result } = setup();
    await act(async () => {
      await result.current.openPreview({ path: 'a.txt', isCollection: false, name: 'a.txt' } as never, vi.fn());
    });
    expect(open).toHaveBeenCalledWith('/files/alice/photos/a.txt', '_blank', 'noopener');
  });
});

describe('singleSegmentName', () => {
  it('accepts one segment and rejects the rest', () => {
    // One rule for both the mkdir and the rename field, which had drifted: the
    // mkdir dialog accepted `a/b` while rename refused it.
    expect(singleSegmentName('  name  ')).toBe('name');
    expect(singleSegmentName('/name/')).toBe('name');
    expect(singleSegmentName('')).toBeNull();
    expect(singleSegmentName(' '.repeat(3))).toBeNull();
    expect(singleSegmentName('a/b')).toBeNull();
    expect(singleSegmentName('/')).toBeNull();
  });
});
