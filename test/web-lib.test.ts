import { describe, expect, it, vi } from 'vitest';
import {
  BackendError,
  buildQuery,
  extractErrorMessage,
  readDav,
  readJson,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  getBackendErrorType,
} from '../apps/web/src/lib/api';
import { BACKEND_TYPE_TO_FALLBACK, BACKEND_TYPE_TO_I18N_KEY, toLocalizedErrorMessage } from '../apps/web/src/lib/backendErrors';
import { formatBytes, formatExpiryTimestamp, resolveLocale } from '../apps/web/src/lib/format';
import { joinDavPath, parentDavPath, parseMultistatus } from '../apps/web/src/lib/davXml';
import { cn } from '../apps/web/src/lib/utils';
import { getBackendErrorMessage, isLikelyAuthError } from '../apps/web/src/lib/backendErrors';

describe('BackendError', () => {
  it('carries the status and the backend error type', () => {
    const error = new BackendError('msg', 'NotFound', 404);
    expect(error.name).toBe('BackendError');
    expect(error.status).toBe(404);
    expect(error.errorType).toBe('NotFound');
    expect(error.message).toBe('msg');
  });

  it('exposes the type for a BackendError and null otherwise', () => {
    expect(getBackendErrorType(new BackendError('m', 'Conflict', 409))).toBe('Conflict');
    expect(getBackendErrorType(new Error('plain'))).toBeNull();
    expect(getBackendErrorType('string')).toBeNull();
  });

  it('is distinguishable from a generic failure by the SPA', () => {
    expect(new BackendError('m', null, 401)).toBeInstanceOf(Error);
  });
});

describe('extractErrorMessage', () => {
  // The router (and a proxied backend behind it) answers with the AWS envelope;
  // an Access login can answer with HTML. All three have to produce a bounded,
  // displayable message.
  it('reads the canonical envelope', () => {
    expect(extractErrorMessage(JSON.stringify({ Exception: { Type: 'NotFound', Message: 'Backend not found' } }), 404)).toEqual({
      message: 'Backend not found',
      type: 'NotFound',
    });
  });

  it('reads a legacy {error,message} body', () => {
    expect(extractErrorMessage(JSON.stringify({ error: 'nope' }), 400)).toEqual({ message: 'nope', type: null });
    expect(extractErrorMessage(JSON.stringify({ message: 'nope' }), 400)).toEqual({ message: 'nope', type: null });
  });

  it('truncates an over-long message', () => {
    const long = 'x'.repeat(900);
    const { message } = extractErrorMessage(JSON.stringify({ Exception: { Message: long } }), 500);
    expect(message.length).toBeLessThanOrEqual(501);
    expect(message.endsWith('…')).toBe(true);
  });

  it('truncates a plain-text body, so an HTML login page cannot flood the UI', () => {
    const html = `<html>${'y'.repeat(2000)}</html>`;
    const { message, type } = extractErrorMessage(html, 403);
    expect(message.length).toBeLessThanOrEqual(501);
    expect(type).toBeNull();
  });

  it('falls back to the status for an empty body', () => {
    expect(extractErrorMessage('', 502)).toEqual({ message: 'HTTP 502', type: null });
  });

  it('synthesizes a message when only the type is present', () => {
    expect(extractErrorMessage(JSON.stringify({ Exception: { Type: 'Conflict' } }), 409)).toEqual({
      message: 'Conflict (HTTP 409)',
      type: 'Conflict',
    });
  });

  it('handles a JSON body that is not an error shape', () => {
    const { message, type } = extractErrorMessage(JSON.stringify({ unrelated: true }), 200);
    expect(type).toBeNull();
    expect(message.length).toBeGreaterThan(0);
  });
});

describe('buildQuery', () => {
  it('encodes scalar parameters', () => {
    expect(buildQuery({ backend: 'office' })).toBe('backend=office');
  });

  it('drops undefined and empty values rather than sending blanks', () => {
    // An empty `?backend=` is read as an absent selector by the router, so
    // sending it is noise at best and a stray selector at worst.
    expect(buildQuery({ a: 'x', b: undefined, c: '' })).toBe('a=x');
  });

  it('repeats an array parameter', () => {
    expect(buildQuery({ tag: ['a', 'b'] })).toBe('tag=a&tag=b');
  });

  it('percent-encodes reserved characters', () => {
    expect(buildQuery({ q: 'a b&c=d' })).toBe('q=a+b%26c%3Dd');
  });

  it('returns an empty string for no parameters', () => {
    expect(buildQuery({})).toBe('');
  });
});

describe('readJson', () => {
  it('parses a successful JSON body', async () => {
    expect(await readJson<{ ok: boolean }>(new Response('{"ok":true}', { status: 200 }))).toEqual({ ok: true });
  });

  it('throws a BackendError with the parsed message for a failure', async () => {
    const res = new Response(JSON.stringify({ Exception: { Type: 'NotFound', Message: 'gone' } }), { status: 404 });
    await expect(readJson(res)).rejects.toBeInstanceOf(BackendError);
  });

  it('propagates the status and type', async () => {
    const res = new Response(JSON.stringify({ Exception: { Type: 'Conflict', Message: 'dupe' } }), { status: 409 });
    await readJson(res).catch((e: unknown) => {
      expect(e).toBeInstanceOf(BackendError);
      expect((e as BackendError).status).toBe(409);
      expect((e as BackendError).errorType).toBe('Conflict');
    });
  });
});

describe('readDav', () => {
  it('accepts 207, which is a DAV success', async () => {
    // `Response.ok` is false for 207, so treating it as an error would break
    // every PROPFIND.
    expect(await readDav(new Response('<multistatus/>', { status: 207 }))).toBe('<multistatus/>');
  });

  it('accepts 200', async () => {
    expect(await readDav(new Response('body', { status: 200 }))).toBe('body');
  });

  it('throws a BackendError for a DAV failure', async () => {
    await expect(readDav(new Response('nope', { status: 403 }))).rejects.toBeInstanceOf(BackendError);
  });

  it('tolerates an unreadable failure body', async () => {
    const res = { ok: false, status: 500, text: async () => { throw new Error('stream error'); } } as unknown as Response;
    await expect(readDav(res)).rejects.toBeInstanceOf(BackendError);
  });
});

describe('API verbs', () => {
  const withFetch = async (impl: (url: string, init?: RequestInit) => Promise<Response>, run: () => Promise<unknown>): Promise<unknown> => {
    const original = globalThis.fetch;
    globalThis.fetch = impl as unknown as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it('appends a query string for apiGet', async () => {
    const seen: string[] = [];
    await withFetch(
      async (url) => {
        seen.push(String(url));
        return new Response('{}', { status: 200 });
      },
      () => apiGet('/user/backends', { backend: 'office' }),
    );
    expect(seen[0]).toBe('/user/backends?backend=office');
  });

  it('omits the question mark when there are no parameters', async () => {
    const seen: string[] = [];
    await withFetch(
      async (url) => {
        seen.push(String(url));
        return new Response('{}', { status: 200 });
      },
      () => apiGet('/user/backends'),
    );
    expect(seen[0]).toBe('/user/backends');
  });

  it('sends JSON for a write verb', async () => {
    const seen: RequestInit[] = [];
    await withFetch(
      async (_url, init) => {
        seen.push(init ?? {});
        return new Response('{}', { status: 200 });
      },
      () => apiPost('/user/backends', { slug: 'a' }),
    );
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe('{"slug":"a"}');
  });

  it('sends the right method for each verb', async () => {
    const methods: string[] = [];
    const capture = async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method));
      return new Response('{}', { status: 200 });
    };
    await withFetch(capture, async () => {
      await apiPost('/x', {});
      await apiPatch('/x', {});
      await apiPut('/x', {});
      await apiDelete('/x');
    });
    expect(methods).toEqual(['POST', 'PATCH', 'PUT', 'DELETE']);
  });

  it('omits the body when none is given', async () => {
    const seen: RequestInit[] = [];
    await withFetch(
      async (_url, init) => {
        seen.push(init ?? {});
        return new Response('{}', { status: 200 });
      },
      () => apiPost('/x'),
    );
    expect(seen[0]?.body).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('drops the decimal once the number is large', () => {
    expect(formatBytes(15 * 1024)).toBe('15 KB');
  });

  it('treats a missing value as zero', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });
});

describe('formatExpiryTimestamp', () => {
  it('says never for an absent timestamp', () => {
    expect(formatExpiryTimestamp(null)).toBe('Never');
    expect(formatExpiryTimestamp(undefined)).toBe('Never');
  });

  it('describes near-term expiry relatively', () => {
    const now = Math.floor(Date.now() / 1000);
    // The formatter floors a millisecond difference, so a value that sits
    // exactly on a bucket edge can round down by one depending on when the
    // second clock read lands. Assert the unit rather than the exact count.
    expect(formatExpiryTimestamp(now + 30)).toBe('Expires soon');
    expect(formatExpiryTimestamp(now + 20 * 60)).toMatch(/^Expires in (19|20)m$/);
    expect(formatExpiryTimestamp(now + 5 * 3600)).toMatch(/^Expires in (4|5)h$/);
    expect(formatExpiryTimestamp(now + 3 * 86_400)).toMatch(/^Expires in (2|3)d$/);
  });

  it('picks the right unit for each magnitude', () => {
    // Exact-count assertions are only stable away from a bucket boundary.
    const now = Math.floor(Date.now() / 1000);
    expect(formatExpiryTimestamp(now + 90)).toMatch(/^Expires in 1m$/);
    expect(formatExpiryTimestamp(now + 45 * 60)).toMatch(/^Expires in (44|45)m$/);
    // 30 hours is 1.25 days, so it belongs in the day bucket, not the hour one.
    expect(formatExpiryTimestamp(now + 30 * 3600)).toMatch(/^Expires in 1d$/);
  });

  it('reports an already-elapsed timestamp as expiring soon', () => {
    expect(formatExpiryTimestamp(Math.floor(Date.now() / 1000) - 10)).toBe('Expires soon');
  });

  it('switches to a date past 30 days', () => {
    const far = Math.floor(Date.now() / 1000) + 90 * 86_400;
    expect(formatExpiryTimestamp(far)).toMatch(/^Expires /);
    expect(formatExpiryTimestamp(far)).not.toMatch(/Expires in/);
  });
});

describe('resolveLocale', () => {
  it('defaults to English for an absent tag', () => {
    expect(resolveLocale()).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale('')).toBe('en');
  });
});

describe('dav path helpers', () => {
  it('joins without doubling separators', () => {
    expect(joinDavPath('', 'a')).toBe('a');
    expect(joinDavPath('a/b', 'c')).toBe('a/b/c');
    expect(joinDavPath('/a/', '/b')).toBe('a/b');
  });

  it('walks to the parent and reports the root as null', () => {
    expect(parentDavPath('a/b/c')).toBe('a/b');
    expect(parentDavPath('a')).toBe('');
    expect(parentDavPath('')).toBeNull();
    expect(parentDavPath('/')).toBeNull();
  });
});

describe('parseMultistatus self-response handling', () => {
  const listing = (hrefs: string[]) =>
    `<multistatus xmlns="DAV:">${hrefs
      .map((h) => `<response><href>${h}</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response>`)
      .join('')}</multistatus>`;

  it('drops the listed collection itself', () => {
    // A Depth:1 listing includes the collection, which is not a child.
    const entries = parseMultistatus(listing(['/', '/a.txt']), '');
    expect(entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('drops the self entry at a nested path', () => {
    const entries = parseMultistatus(listing(['/dir/', '/dir/b.txt']), 'dir');
    expect(entries.map((e) => e.name)).toEqual(['b.txt']);
  });

  it('orders collections before files', () => {
    const xml = `<multistatus xmlns="DAV:">
      <response><href>/z.txt</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response>
      <response><href>/a/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
    </multistatus>`;
    expect(parseMultistatus(xml, '').map((e) => e.name)).toEqual(['a', 'z.txt']);
  });

  it('orders names case-insensitively within a group', () => {
    expect(parseMultistatus(listing(['/B.txt', '/a.txt']), '').map((e) => e.name)).toEqual(['a.txt', 'B.txt']);
  });

  it('returns nothing for an empty or non-DAV body', () => {
    expect(parseMultistatus('', '')).toEqual([]);
    expect(parseMultistatus('<html>denied</html>', '')).toEqual([]);
  });
});

describe('cn', () => {
  it('joins class names and drops falsy values', () => {
    expect(cn('a', 'b')).toBe('a b');
    expect(cn('a', false, undefined, 'b')).toBe('a b');
    expect(cn()).toBe('');
  });
});

describe('toLocalizedErrorMessage', () => {
  // Backend `Message` values are English by design, so a typed error resolves to
  // a localized `errors.backend.*` string. Raw backend English must never reach
  // the notice bar.
  const t = vi.fn((key: string, fallback: string) => `t(${key})|${fallback}`);

  it('maps a known type to its i18n key and English fallback', () => {
    expect(toLocalizedErrorMessage(t, new BackendError('Backend not found', 'NotFound', 404), 'errors.generic', 'Generic.')).toBe(
      't(errors.backend.notFound)|Not Found.',
    );
  });

  it('covers every mapped type with both a key and a fallback', () => {
    // A type with a key but no fallback would render an empty string whenever
    // the translation bundle is missing that key.
    for (const type of Object.keys(BACKEND_TYPE_TO_I18N_KEY)) {
      expect(BACKEND_TYPE_TO_FALLBACK[type], type).toBeTruthy();
    }
  });

  it('has an i18n key and fallback for every type the router can emit', () => {
    // The router's `Exception.Type` values are a wire contract; an unmapped one
    // silently degrades to the generic message.
    for (const type of ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound', 'Conflict', 'PayloadTooLarge', 'RateLimited', 'MethodNotAllowed', 'InternalServerError']) {
      expect(BACKEND_TYPE_TO_I18N_KEY[type], type).toBeTruthy();
    }
  });

  it('falls back for an unmapped type', () => {
    expect(toLocalizedErrorMessage(t, new BackendError('x', 'SomethingNew', 400), 'errors.generic', 'Generic.')).toBe('t(errors.generic)|Generic.');
  });

  it('falls back for a non-BackendError', () => {
    expect(toLocalizedErrorMessage(t, new Error('boom'), 'errors.generic', 'Generic.')).toBe('t(errors.generic)|Generic.');
  });

  it('falls back for an untyped BackendError', () => {
    // A proxied HTML login page yields a BackendError with no Exception.Type.
    expect(toLocalizedErrorMessage(t, new BackendError('<html>', null, 403), 'errors.generic', 'Generic.')).toBe('t(errors.generic)|Generic.');
  });
});
