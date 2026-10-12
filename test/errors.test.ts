import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, ConflictError, DatabaseError, DefaultInternalServerError, ForbiddenError, InternalServerError, MethodNotAllowedError, NotFoundError, PayloadTooLargeError, RateLimitedError, ServiceError, UnauthorizedError } from '@rexezuge/errors';
import { mapServiceError, toServiceStatus, buildBody } from '@durable-dav-router/backend-services/errors';
import { getLocalizedStrings } from '@rexezuge/i18n';

describe('ServiceError hierarchy', () => {
  // Each error's status and Type string are part of the wire contract: the SPA
  // branches on `Exception.Type`, so a change here is a breaking API change.
  const cases: Array<[string, () => ServiceError, number, string]> = [
    ['BadRequestError', () => new BadRequestError('bad'), 400, 'BadRequest'],
    ['UnauthorizedError', () => new UnauthorizedError('nope'), 401, 'Unauthorized'],
    ['ForbiddenError', () => new ForbiddenError('nope'), 403, 'Forbidden'],
    ['NotFoundError', () => new NotFoundError('gone'), 404, 'NotFound'],
    ['ConflictError', () => new ConflictError('dupe'), 409, 'Conflict'],
    ['PayloadTooLargeError', () => new PayloadTooLargeError('big'), 413, 'PayloadTooLarge'],
    ['RateLimitedError', () => new RateLimitedError(), 429, 'RateLimited'],
    ['MethodNotAllowedError', () => new MethodNotAllowedError(), 405, 'MethodNotAllowed'],
  ];

  for (const [name, make, status, type] of cases) {
    it(`${name} maps to ${status} ${type}`, () => {
      const error = make();
      expect(error).toBeInstanceOf(ServiceError);
      // The kit's taxonomy: the status and the catalog key are fields, the
      // wire envelope reads them straight off the error.
      expect(error.status).toBe(status);
      expect(error.type).toBe(type);
    });
  }

  it('carries its own message', () => {
    expect(new NotFoundError('Backend not found').message).toBe('Backend not found');
  });

  it('supplies a default message when none is given', () => {
    // `rateLimit` constructs RateLimitedError with no argument, so a default has
    // to be a usable client-facing sentence rather than an empty string.
    const defaults: Array<[string, () => ServiceError]> = [
      ['RateLimitedError', () => new RateLimitedError()],
      ['BadRequestError', () => new BadRequestError()],
      ['UnauthorizedError', () => new UnauthorizedError()],
      ['ForbiddenError', () => new ForbiddenError()],
      ['NotFoundError', () => new NotFoundError()],
      ['ConflictError', () => new ConflictError()],
      ['PayloadTooLargeError', () => new PayloadTooLargeError()],
      ['MethodNotAllowedError', () => new MethodNotAllowedError()],
    ];
    for (const [name, make] of defaults) {
      const message = make().message;
      expect(typeof message, name).toBe('string');
      expect(message.trim().length, name).toBeGreaterThan(0);
    }
  });

  it('is catchable as Error', () => {
    const error = new BadRequestError('x');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('x');
  });
});

describe('DatabaseError', () => {
  it('reports 500 and marks itself non-retryable by default', () => {
    // A UNIQUE violation will never succeed on retry, so retrying it wastes
    // three round trips and then returns the same failure.
    const error = new DatabaseError('UNIQUE constraint failed: router_backends.owner_email');
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(false);
  });

  it('can be marked retryable for genuinely transient faults', () => {
    expect(new DatabaseError('network', true).retryable).toBe(true);
  });

  it('exposes the underlying driver text for logging', () => {
    // The message is masked on the way out; `ErrorMapper` logs it instead.
    expect(new DatabaseError('no such table: users').message).toBe('no such table: users');
  });
});

describe('InternalServerError', () => {
  it('reports 500', () => {
    expect(new InternalServerError('boom').status).toBe(500);
  });

  it('exposes a shared default instance for masked responses', () => {
    expect(DefaultInternalServerError.type).toBe('InternalServerError');
    expect(DefaultInternalServerError.status).toBe(500);
  });
});

describe('mapServiceError', () => {
  it('passes a client error through with its own message', () => {
    const { status, body } = mapServiceError(new NotFoundError('Backend not found'));
    expect(status).toBe(404);
    expect(body.Exception?.Type).toBe('NotFound');
    expect(body.Exception?.Message).toBe('Backend not found');
  });

  it('masks a DatabaseError, which carries table and column names', () => {
    // The raw message would disclose the schema: `router_backends.owner_email`
    // and which constraint fired.
    const { status, body } = mapServiceError(new DatabaseError('UNIQUE constraint failed: router_backends.owner_email'));
    expect(status).toBe(500);
    expect(body.Exception?.Type).toBe('InternalServerError');
    expect(body.Exception?.Message).not.toMatch(/router_backends|constraint/i);
  });

  it('masks a 5xx ServiceError too', () => {
    const { status, body } = mapServiceError(new InternalServerError('connection string postgres://user:hunter2@host/db'));
    expect(status).toBe(500);
    expect(body.Exception?.Message).not.toMatch(/postgres|hunter2/);
  });

  it('masks an untyped throwable', () => {
    const { status, body } = mapServiceError(new TypeError('x.y is not a function'));
    expect(status).toBe(500);
    expect(body.Exception?.Type).toBe('InternalServerError');
    expect(body.Exception?.Message).not.toMatch(/not a function/);
  });

  it('localizes the masked message', () => {
    expect(mapServiceError(new Error('secret'), 'ja').body.Exception?.Message).toBe(getLocalizedStrings('ja').common.internalError);
    expect(mapServiceError(new Error('secret')).body.Exception?.Message).toBe(getLocalizedStrings('en').common.internalError);
  });

  it('does not localize a client error message', () => {
    // A domain error's message is part of the contract; translating it would
    // change what a client matches on.
    expect(mapServiceError(new NotFoundError('Backend not found'), 'ja').body.Exception?.Message).toBe('Backend not found');
  });

  it('handles a thrown non-Error without throwing itself', () => {
    expect(mapServiceError('a string').status).toBe(500);
    expect(mapServiceError(undefined).status).toBe(500);
  });

  it('always emits the AWS-style envelope', () => {
    for (const error of [new BadRequestError('a'), new DatabaseError('b'), new Error('c')]) {
      expect(Object.keys(mapServiceError(error).body)).toEqual(['Exception']);
    }
  });
});

describe('buildBody', () => {
  it('is the unmasked body for a client error', () => {
    expect(buildBody(new ConflictError('dupe'))).toEqual({ Exception: { Type: 'Conflict', Message: 'dupe' } });
  });
});

describe('toServiceStatus', () => {
  it('passes known client statuses through', () => {
    expect(toServiceStatus(new BadRequestError())).toBe(400);
    expect(toServiceStatus(new NotFoundError())).toBe(404);
    expect(toServiceStatus(new RateLimitedError())).toBe(429);
  });

  it('collapses everything else to 500', () => {
    // Including a 405: it is a real status but not part of the JSON API's set,
    // and a WebDAV 405 is produced as a raw Response, not through the mapper.
    expect(toServiceStatus(new MethodNotAllowedError())).toBe(500);
    expect(toServiceStatus(new DatabaseError('x'))).toBe(500);
    expect(toServiceStatus(new Error('x'))).toBe(500);
    expect(toServiceStatus('not an error')).toBe(500);
  });
});

describe('error logging', () => {
  it('logs the cause of a masked 500 so it stays diagnosable', () => {
    // Masking the body is only safe if the cause is still recorded somewhere.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mapServiceError(new DatabaseError('UNIQUE constraint failed: router_backends'));
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
