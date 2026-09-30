import { describe, expect, it } from 'vitest';
import { isD1ErrorRetryable, isMissingSchemaError } from '@durable-dav-router/backend-data/utils';
import { executeD1WithRetry } from '@durable-dav-router/backend-data/utils';
import { DatabaseError } from '@durable-dav-router/backend-errors';
import { buildSetClause } from '@durable-dav-router/backend-data/dao';
import { BaseDAO } from '@durable-dav-router/backend-data/dao';
import type { D1Queryable, D1Result } from '@durable-dav-router/backend-data/utils';

describe('isD1ErrorRetryable', () => {
  it('retries transient faults', () => {
    for (const message of [
      'SQLITE_BUSY: database is locked',
      'connection reset',
      'network error',
      'request timed out',
      'service unavailable',
      'too many requests',
      'deadlock detected',
    ]) {
      expect(isD1ErrorRetryable(message), message).toBe(true);
    }
  });

  it('does not retry faults that will fail identically forever', () => {
    // Retrying these costs three round trips and returns the same failure.
    for (const message of [
      'UNIQUE constraint failed: router_backends.owner_email',
      'FOREIGN KEY constraint failed',
      'no such table: router_backends',
      'SQLITE_ERROR: syntax error',
      'not authorized',
    ]) {
      expect(isD1ErrorRetryable(message), message).toBe(false);
    }
  });

  it('lets a non-retryable signal win over a retryable-looking substring', () => {
    // "connection" is retryable, but a constraint violation that mentions it
    // is not — the permanent signal has to take precedence.
    expect(isD1ErrorRetryable('UNIQUE constraint failed after connection reset')).toBe(false);
  });

  it('defaults to no retry for an unrecognized message', () => {
    expect(isD1ErrorRetryable('something new and unclassified')).toBe(false);
  });

  it('treats an empty message as not retryable', () => {
    expect(isD1ErrorRetryable('')).toBe(false);
  });
});

describe('isMissingSchemaError', () => {
  it('recognizes a missing table, column, or index', () => {
    // This is the one failure where degrading is correct: a database whose
    // migrations have not been applied yet should read as empty, not as a 500.
    for (const message of ['no such table: router_backends', 'D1_ERROR: no such column: backend_username', 'no such index: idx_x']) {
      expect(isMissingSchemaError(new Error(message)), message).toBe(true);
    }
  });

  it('does not treat a genuine outage as a missing schema', () => {
    // Swallowing this is how a D1 outage used to surface as a 404.
    for (const message of ['connection reset', 'UNIQUE constraint failed', 'database is locked']) {
      expect(isMissingSchemaError(new Error(message)), message).toBe(false);
    }
  });

  it('accepts a string or a non-Error', () => {
    expect(isMissingSchemaError('no such table: users')).toBe(true);
    expect(isMissingSchemaError({ message: 'no such table: users' })).toBe(false);
    expect(isMissingSchemaError(undefined)).toBe(false);
  });
});

describe('executeD1WithRetry', () => {
  const ok = (): D1Result => ({ success: true, results: [], meta: {} }) as unknown as D1Result;
  const fail = (error: string): D1Result => ({ success: false, results: [], error, meta: {} }) as unknown as D1Result;

  it('returns the first successful result', async () => {
    expect(await executeD1WithRetry(async () => ok(), 'read')).toMatchObject({ success: true });
  });

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const result = await executeD1WithRetry(
      async () => {
        calls += 1;
        return calls < 3 ? fail('SQLITE_BUSY: database is locked') : ok();
      },
      'read',
      { baseDelayMs: 1 },
    );
    expect(result.success).toBe(true);
    expect(calls).toBe(3);
  });

  it('retries a thrown retryable Error, not just an unsuccessful result', async () => {
    let calls = 0;
    const result = await executeD1WithRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('connection reset');
        return ok();
      },
      'read',
      { baseDelayMs: 1 },
    );
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
  });

  it('raises a DatabaseError naming the operation, not a raw throw', async () => {
    await expect(executeD1WithRetry(async () => fail('UNIQUE constraint failed: t.c'), 'create row')).rejects.toBeInstanceOf(DatabaseError);
  });

  it('does not retry a permanent failure', async () => {
    let calls = 0;
    await expect(
      executeD1WithRetry(
        async () => {
          calls += 1;
          return fail('UNIQUE constraint failed');
        },
        'create row',
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('gives up after the retry budget and reports the last error', async () => {
    let calls = 0;
    await expect(
      executeD1WithRetry(
        async () => {
          calls += 1;
          throw new Error('connection reset');
        },
        'read',
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/connection reset/);
    expect(calls).toBe(3);
  });

  it('rethrows a non-Error throw rather than swallowing it', async () => {
    // A bare string is the subject matter: the point is that a thrown value
    // which is not an `Error` still propagates unchanged.
    const thrown = 'a bare string';
    await expect(
      executeD1WithRetry(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately not an Error
        throw thrown;
      }, 'read'),
    ).rejects.toBe(thrown);
  });

  it('backs off between attempts rather than hammering immediately', async () => {
    // A zero base delay keeps the suite fast while still proving the delay is
    // applied; `sleep` is exported but stubbed here so the wall clock does not
    // dominate the suite.
    const started = Date.now();
    let calls = 0;
    await executeD1WithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('connection reset');
        return { success: true, results: [], meta: {} } as unknown as D1Result;
      },
      'read',
      { baseDelayMs: 5 },
    );
    expect(calls).toBe(3);
    // Two backoffs of 5ms and 10ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(14);
  });
});

describe('buildSetClause', () => {
  it('emits one placeholder per assignment, in order', () => {
    // The value order must match the placeholder order or a column silently
    // receives another column's value.
    const { clause, values } = buildSetClause([
      { column: 'updated_at', value: 1 },
      { column: 'base_url', value: 'https://x' },
      { column: 'display_name', value: null },
    ]);
    expect(clause).toBe('updated_at = ?, base_url = ?, display_name = ?');
    expect(values).toEqual([1, 'https://x', null]);
  });

  it('handles a single assignment', () => {
    expect(buildSetClause([{ column: 'a', value: 1 }])).toEqual({ clause: 'a = ?', values: [1] });
  });

  it('distinguishes a null value from an absent one', () => {
    // `null` clears a column; omitting the assignment leaves it alone.
    expect(buildSetClause([{ column: 'a', value: null }]).values).toEqual([null]);
  });

  it('accepts falsy values that are not null', () => {
    expect(buildSetClause([{ column: 'a', value: 0 }]).values).toEqual([0]);
    expect(buildSetClause([{ column: 'a', value: false }]).values).toEqual([false]);
    expect(buildSetClause([{ column: 'a', value: '' }]).values).toEqual(['']);
  });

  it('produces a clause SQLite rejects for an empty list', () => {
    // Documenting the precondition: a caller with nothing to update must not
    // build a clause, because `SET ` is a syntax error.
    expect(buildSetClause([]).clause).toBe('');
  });
});

describe('BaseDAO', () => {
  it('wraps a failure in a DatabaseError that names the operation', async () => {
    class Probe extends BaseDAO {
      public run(): Promise<D1Result> {
        return this.withRetry(
          async () => ({ success: false, results: [], error: 'UNIQUE constraint failed', meta: {} }) as unknown as D1Result,
          'create probe',
        );
      }
    }
    const dao = new Probe({} as D1Queryable);
    await expect(dao.run()).rejects.toBeInstanceOf(DatabaseError);
    await expect(dao.run()).rejects.toThrow(/create probe/);
  });
});
