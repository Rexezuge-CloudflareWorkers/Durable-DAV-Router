import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { securityHeaders, SECURITY_HEADERS, isSensitiveJsonPath } from '../apps/api/src/middleware/securityHeaders';
import { rateLimit, clientIp, resetRateLimitForTests, getRateLimitBucketCountForTests } from '../apps/api/src/middleware/rateLimit';
import { RATE_LIMIT_DEFS } from '../apps/api/src/middleware/rateLimitConfig';
import { UnauthorizedError, ForbiddenError, BadRequestError, RateLimitedError } from '@durable-dav-router/backend-errors';

type Ctx = Parameters<Parameters<typeof securityHeaders>[0]>[0];

function makeCtx(url: string, options: { method?: string; contentType?: string; headers?: Record<string, string> } = {}) {
  const resHeaders = new Headers();
  if (options.contentType) resHeaders.set('content-type', options.contentType);
  const set = new Map<string, string>();
  return {
    req: { url, method: options.method ?? 'GET', header: (k: string) => options.headers?.[k] ?? null },
    res: { headers: resHeaders },
    header(key: string, value: string) {
      set.set(key.toLowerCase(), value);
    },
    json(data: unknown, status = 200, headers?: Record<string, string>) {
      return new Response(JSON.stringify(data), { status, headers });
    },
    get(key: string) {
      return set.get(key) ?? null;
    },
    set(key: string, value: string) {
      set.set(key, value);
    },
    _headers: set,
  } as unknown as Ctx & { get: (k: string) => string | null };
}

describe('securityHeaders', () => {
  it('sets every baseline header', async () => {
    const c = makeCtx('https://router.example.com/user/backends');
    await securityHeaders()(c, async () => undefined);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(c.get(key.toLowerCase()), key).toBe(value);
    }
  });

  it('never serves a response as a frame or a different content type', async () => {
    const c = makeCtx('https://router.example.com/');
    await securityHeaders()(c, async () => undefined);
    expect(c.get('x-frame-options')).toBe('DENY');
    expect(c.get('x-content-type-options')).toBe('nosniff');
  });

  it('adds a CSP only to the HTML shell', async () => {
    // A CSP on a PROPFIND multistatus response is meaningless; on the SPA shell
    // it is the main defence against injected script.
    const html = makeCtx('https://router.example.com/', { contentType: 'text/html; charset=utf-8' });
    await securityHeaders()(html, async () => undefined);
    expect(html.get('content-security-policy')).toMatch(/default-src 'self'/);
    const json = makeCtx('https://router.example.com/user/me', { contentType: 'application/json' });
    await securityHeaders()(json, async () => undefined);
    expect(json.get('content-security-policy')).toBeNull();
  });

  it('forbids framing in the CSP as well as the header', async () => {
    const c = makeCtx('https://router.example.com/', { contentType: 'text/html' });
    await securityHeaders()(c, async () => undefined);
    expect(c.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('marks /user/* responses no-store so credentials are never cached', () => {
    for (const path of ['/user/me', '/user/backends', '/user/volumes/a/b']) {
      expect(isSensitiveJsonPath(path), path).toBe(true);
    }
  });

  it('leaves public volume paths cacheable', () => {
    for (const path of ['/', '/owner/volume', '/owner/volume/file.txt', '/health']) {
      expect(isSensitiveJsonPath(path), path).toBe(false);
    }
  });

  it('sets no-store on /user/* but not on a volume path', async () => {
    const sensitive = makeCtx('https://router.example.com/user/backends');
    await securityHeaders()(sensitive, async () => undefined);
    expect(sensitive.get('cache-control')).toBe('no-store');
    const publicPath = makeCtx('https://router.example.com/owner/vol');
    await securityHeaders()(publicPath, async () => undefined);
    expect(publicPath.get('cache-control')).toBeNull();
  });

  it('sends HSTS over HTTPS only', async () => {
    // Over plain HTTP it risks local pinning and browsers ignore it anyway.
    const secure = makeCtx('https://router.example.com/user/me');
    await securityHeaders()(secure, async () => undefined);
    expect(secure.get('strict-transport-security')).toMatch(/max-age=\d+/);
    const plain = makeCtx('http://localhost:8787/user/me');
    await securityHeaders()(plain, async () => undefined);
    expect(plain.get('strict-transport-security')).toBeNull();
  });

  it('applies headers after the handler, so a route cannot drop them', async () => {
    const c = makeCtx('https://router.example.com/');
    await securityHeaders()(c, async () => {
      expect(c.get('x-frame-options')).toBeNull();
    });
    expect(c.get('x-frame-options')).toBe('DENY');
  });

  it('never fails the request on a malformed URL', async () => {
    const c = makeCtx('not a url at all');
    await expect(securityHeaders()(c, async () => undefined)).resolves.toBeUndefined();
    expect(c.get('x-frame-options')).toBe('DENY');
  });
});

describe('rateLimit registration', () => {
  it('rejects malformed options at registration time', () => {
    // Silently installing an unlimited or instantly-tripping bucket is worse
    // than failing during wiring.
    expect(() => rateLimit({ windowMs: 0, max: 10, keyPrefix: 'k' })).toThrow(/windowMs/);
    expect(() => rateLimit({ windowMs: -1, max: 10, keyPrefix: 'k' })).toThrow(/windowMs/);
    expect(() => rateLimit({ windowMs: 1.5, max: 10, keyPrefix: 'k' })).toThrow(/windowMs/);
    expect(() => rateLimit({ windowMs: 1000, max: 0, keyPrefix: 'k' })).toThrow(/max/);
    expect(() => rateLimit({ windowMs: 1000, max: -1, keyPrefix: 'k' })).toThrow(/max/);
    expect(() => rateLimit({ windowMs: 1000, max: 1, keyPrefix: '' })).toThrow(/keyPrefix/);
    expect(() => rateLimit({ windowMs: 1000, max: 1, keyPrefix: '   ' })).toThrow(/keyPrefix/);
  });

  it('accepts valid options', () => {
    expect(() => rateLimit({ windowMs: 1000, max: 1, keyPrefix: 'k' })).not.toThrow();
  });

  it('ships only valid definitions', () => {
    for (const def of RATE_LIMIT_DEFS) {
      expect(() => rateLimit({ windowMs: def.windowMs, max: def.max, keyPrefix: def.keyPrefix }), def.keyPrefix).not.toThrow();
    }
  });

  it('limits backend registration, the endpoint that creates an outbound destination', () => {
    // Omitting this is what left registration unlimited: each accepted request
    // also triggers a health probe from Worker egress.
    const create = RATE_LIMIT_DEFS.find((d) => d.path === '/user/backends');
    expect(create).toBeDefined();
    expect(create?.max).toBeLessThanOrEqual(20);
  });

  it('uses unique key prefixes so buckets cannot collide', () => {
    const prefixes = RATE_LIMIT_DEFS.map((d) => d.keyPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('clientIp', () => {
  it('trusts CF-Connecting-IP, which a client cannot forge', () => {
    const c = makeCtx('https://x/', { headers: { 'CF-Connecting-IP': '203.0.113.5' } });
    expect(clientIp(c as never)).toBe('203.0.113.5');
  });

  it('ignores X-Forwarded-For so a caller cannot rotate buckets', () => {
    const c = makeCtx('https://x/', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    expect(clientIp(c as never)).toBe('unknown');
  });

  it('groups every headerless caller into one bucket', () => {
    // Fail-closed grouping: per-spoofed-header isolation would let an attacker
    // get a fresh budget per request.
    expect(clientIp(makeCtx('https://x/') as never)).toBe('unknown');
  });
});

describe('rateLimit', () => {
  beforeEach(() => resetRateLimitForTests());
  afterEach(() => resetRateLimitForTests());

  const ctx = (identity: string | undefined) => makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }) as never as Parameters<ReturnType<typeof rateLimit>>[0] & { _identity?: string };

  it('allows requests up to the limit, then rejects with 429 and Retry-After', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 2, keyPrefix: 'test' });
    for (let i = 0; i < 2; i += 1) {
      const c = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
      await middleware(c as never, async () => undefined);
    }
    const blocked = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    const res = (await middleware(blocked as never, async () => undefined)) as Response;
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('returns the canonical RateLimited envelope, not a hand-built one', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'env' });
    const first = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.8' } });
    await middleware(first as never, async () => undefined);
    const second = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.8' } });
    const res = (await middleware(second as never, async () => undefined)) as Response;
    const body = (await res.json()) as { Exception: { Type: string; Message: string } };
    expect(body.Exception.Type).toBe(new RateLimitedError().getErrorType());
    expect(body.Exception.Message).toBe(new RateLimitedError().getErrorMessage());
  });

  it('keeps separate budgets per identity', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'sep' });
    const a = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.1' } });
    await middleware(a as never, async () => undefined);
    const b = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.2' } });
    // A different caller must not be affected by the first one's spend.
    await expect(middleware(b as never, async () => undefined)).resolves.toBeUndefined();
  });

  it('separates buckets by key prefix', async () => {
    const first = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'p1' });
    const second = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'p2' });
    const c1 = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.3' } });
    await first(c1 as never, async () => undefined);
    const c2 = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.3' } });
    // Same caller, different bucket: must still pass.
    await expect(second(c2 as never, async () => undefined)).resolves.toBeUndefined();
  });

  it('calls the downstream handler on every allowed request', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'next' });
    const next = vi.fn(async () => undefined);
    const c = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.4' } });
    await middleware(c as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('fails open rather than 500ing a legitimate request', async () => {
    // Limiting must never be the reason a request fails.
    const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'failopen' });
    const c = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': '203.0.113.5' } });
    const broken = {
      ...c,
      get: () => {
        throw new Error('context exploded');
      },
    };
    const next = vi.fn(async () => undefined);
    await expect(middleware(broken as never, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('bounds the bucket map so one isolate cannot grow without limit', () => {
    // Drive far more distinct keys than the cap and confirm the map stays bounded.
    const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'flood' });
    for (let i = 0; i < 6000; i += 1) {
      const c = makeCtx('https://x/user/me', { headers: { 'CF-Connecting-IP': `10.0.${Math.floor(i / 256)}.${i % 256}` } });
      void middleware(c as never, async () => undefined);
    }
    expect(getRateLimitBucketCountForTests()).toBeLessThanOrEqual(5000);
  });
});

describe('error status mapping used by the auth guard', () => {
  it('maps auth failures to the right statuses', () => {
    // These are the classes `userAuthenticationHandler` distinguishes; the
    // statuses are what a client branches on.
    expect(new UnauthorizedError('x').getErrorCode()).toBe(401);
    expect(new ForbiddenError('x').getErrorCode()).toBe(403);
    expect(new BadRequestError('x').getErrorCode()).toBe(400);
  });
});
