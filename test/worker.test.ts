import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { DurableDavRouterWorker } from '../apps/api/src/workers/DurableDavRouterWorker';
import { SPA_HTML } from '../apps/api/src/generated/spa-shell';
import { resetRateLimitForTests } from '../apps/api/src/middleware/rateLimit';

type Fetchable = { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> };

const worker = (): Fetchable => new DurableDavRouterWorker() as unknown as Fetchable;

/**
 * A D1 binding with no rows.
 *
 * This was `{}`, which is not a database: reaching it produced
 * `this.database.prepare is not a function`, and the WebDAV proxy swallowed that
 * `TypeError` into an empty result set — so the "no backend for this owner"
 * answer these tests assert was, in the fixture, actually an *unavailable
 * database* reading as "not found". Now that a fault propagates, a faithful
 * empty result is modelled instead, which is what the assertions mean.
 */
const emptyDb = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    }),
  }),
};

const ENV = {
  DB: emptyDb,
  ENVIRONMENT: 'development',
  DEV_AUTH_EMAIL: 'test@example.com',
  TEAM_DOMAIN: '',
  POLICY_AUD: '',
};

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => undefined });

const call = (w: Fetchable, path: string, init?: RequestInit) =>
  w.fetch(new Request(`https://router.example.com${path}`, init), ENV, ctx());

beforeEach(() => resetRateLimitForTests());
afterEach(() => {
  resetRateLimitForTests();
  vi.restoreAllMocks();
});

/**
Typo-tolerant access to the protected `onRequest` for config-warning tests.
*/
const withConfigProbe = (w: object) => w as unknown as { onRequest: (r: Request, e: unknown, c: unknown) => Promise<Response> };

describe('worker bootstrap', () => {
  it('exposes fetch', () => {
    expect(typeof worker().fetch).toBe('function');
  });

  it('answers /health without a database or identity', async () => {
    const res = await call(worker(), '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'durable-dav-router' });
  });

  it('serves the SPA shell for each client-side route', async () => {
    // These are browser document navigations; the same paths reached with a DAV
    // `Accept` fall through to the proxy instead.
    for (const path of ['/', '/new', '/backends/new', '/settings']) {
      const res = await call(worker(), path, { headers: { Accept: 'text/html' } });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(SPA_HTML);
    }
  });

  it('serves the volume view to a browser navigating to a volume root', async () => {
    // Content negotiation: `Accept: text/html` means "this is a document
    // navigation", which must not be proxied to a backend as a file GET.
    const res = await call(worker(), '/owner/volume', { headers: { Accept: 'text/html,application/xhtml+xml' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SPA_HTML);
  });

  it('does not serve the shell to a WebDAV client asking for a volume root', async () => {
    // A DAV client sending `Accept: */*` must reach the proxy, not the SPA.
    const res = await call(worker(), '/owner/volume', { method: 'PROPFIND', headers: { Accept: '*/*' } });
    expect(res.status).toBe(404);
  });

  it('serves the OpenAPI document at /docs', async () => {
    const res = await call(worker(), '/docs');
    expect(res.status).toBe(200);
  });

  it('404s an unknown API path', async () => {
    const res = await call(worker(), '/not/a/route');
    expect(res.status).toBe(404);
  });
});

describe('configuration validation runs once per isolate', () => {
  it('logs a warning for a malformed numeric var', async () => {
    // A bad numeric var silently becomes its default at request time, so the
    // only chance to report it is at startup.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = new DurableDavRouterWorker() as unknown as { onRequest: (r: Request, e: unknown, c: unknown) => Promise<Response> };
    await withConfigProbe(w).onRequest(new Request('https://router.example.com/health'), { ...ENV, MAX_BACKENDS_PER_USER: 'lots' }, ctx());
    const first = spy.mock.calls.length;
    expect(spy.mock.calls.some((c) => String(c[0]).includes('MAX_BACKENDS_PER_USER'))).toBe(true);
    await withConfigProbe(w).onRequest(new Request('https://router.example.com/health'), { ...ENV, MAX_BACKENDS_PER_USER: 'lots' }, ctx());
    // Validated once, not per request: a per-request log would be noise and cost.
    expect(spy.mock.calls).toHaveLength(first);
  });

  it('says nothing for a clean configuration', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = new DurableDavRouterWorker() as unknown as { onRequest: (r: Request, e: unknown, c: unknown) => Promise<Response> };
    await withConfigProbe(w).onRequest(new Request('https://router.example.com/health'), ENV, ctx());
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('[config]'))).toHaveLength(0);
  });

  it('never fails a request because validation threw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = new DurableDavRouterWorker() as unknown as { onRequest: (r: Request, e: unknown, c: unknown) => Promise<Response> };
    // A hostile env shape (a getter that throws) must not take the worker down.
    const hostile = {
      ...ENV,
      get ENVIRONMENT(): string {
        throw new Error('exploding getter');
      },
    };
    const res = await withConfigProbe(w).onRequest(new Request('https://router.example.com/health'), hostile, ctx());
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();
  });
});

describe('uncaught errors', () => {
  it('returns a masked 500 in the canonical envelope when a DAO call fails', async () => {
    // Auth has to succeed first, so the bypass env is used and the failure is
    // injected at the D1 layer the route actually reads. The thrown text names a
    // secret, so it must not reach the client.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = worker();
    const explodingDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('D1_ERROR: secret token leaked from the driver');
          },
          all: async () => {
            throw new Error('D1_ERROR: secret token leaked from the driver');
          },
          run: async () => {
            throw new Error('D1_ERROR: secret token leaked from the driver');
          },
        }),
      }),
    };
    try {
      const res = await w.fetch(new Request('https://router.example.com/user/backends'), { ...ENV, DB: explodingDb }, ctx());
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toMatch(/InternalServerError/);
      expect(text).not.toMatch(/secret token/);
      // The cause is still recorded server-side, so the failure stays diagnosable.
      expect(spy.mock.calls.some((c) => JSON.stringify(c).includes('secret token'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('rate limiting is wired into the app', () => {
  it('applies a bucket to /user/me', async () => {
    // `registerRateLimits` had no call site, so no route was limited at all.
    // `/user/me` 401s in this env (TEAM_DOMAIN unset, bypass refused), which is
    // still a request the bucket must count.
    const w = worker();
    const statuses: number[] = [];
    for (let i = 0; i < 130; i += 1) {
      const res = await call(w, '/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.5' } });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it('reports a Retry-After so a client knows when to come back', async () => {
    const w = worker();
    let limited: Response | undefined;
    for (let i = 0; i < 130; i += 1) {
      const res = await call(w, '/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.6' } });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited?.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('gives a different caller its own budget', async () => {
    const w = worker();
    for (let i = 0; i < 130; i += 1) await call(w, '/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    // A second IP must not inherit the first one's exhaustion. 200 or 401 both
    // prove the request got through: the dev-bypass identity in this env is not
    // usable here because `TEAM_DOMAIN` is unset, so /user/me legitimately 401s.
    const res = await call(w, '/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.8' } });
    expect(res.status).not.toBe(429);
  });

  it('does not limit the health endpoint', async () => {
    // A health check must never be throttled, or a deploy looks unhealthy.
    const w = worker();
    for (let i = 0; i < 20; i += 1) {
      const res = await call(w, '/health');
      expect(res.status).toBe(200);
    }
  });
});

describe('CORS preflight', () => {
  it('answers OPTIONS on /user/* before authentication', async () => {
    // A preflight carries no credentials by design; requiring auth broke every
    // cross-origin call to the authenticated API. `Access-Control-Request-Method`
    // is what makes this a preflight rather than a DAV capability probe, and a
    // browser always sends it — which is why it is safe to narrow the shortcut
    // to requests that carry it.
    const res = await call(worker(), '/user/backends', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(204);
  });

  it('answers a DAV OPTIONS that is not a preflight with the proxy 404, not 204', async () => {
    // A DAV capability probe carries no `Access-Control-Request-Method`, so it
    // must reach the DAV proxy rather than the preflight shortcut. The empty
    // database has no backend for this owner, which is the same 404 a PROPFIND
    // gets. A bare 204 here is the regression: RFC 4918 §9.1 clients read the
    // missing `DAV:` header as "not a DAV server" and abort with "No Content".
    const res = await call(worker(), '/owner/volume', { method: 'OPTIONS' });
    expect(res.status).toBe(404);
  });

  it('answers a preflight on a DAV path without proxying it', async () => {
    // A browser preflighting a cross-origin DAV call is still ours: it must not
    // be forwarded to a backend, and must not be answered 401.
    const res = await call(worker(), '/owner/volume', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'PROPFIND' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PROPFIND');
  });

  it('does not grant a non-allow-listed origin', async () => {
    const res = await call(worker(), '/user/backends', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('AbstractEntrypointWorker contract', () => {
  it('converts a thrown error into a 500 rather than rejecting', async () => {
    // The base class is the outermost boundary; a rejection here would surface
    // as an unhandled worker error with no response at all. Extending through
    // the `DurableDavRouterWorker` constructor keeps the real `onRequest`
    // signature in the `override` check below.
    class Boom extends DurableDavRouterWorker {
      protected override onRequest(): Promise<Response> {
        return Promise.reject(new Error('boom'));
      }
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await (new Boom() as unknown as Fetchable).fetch(new Request('https://router.example.com/x'), ENV, ctx());
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});
