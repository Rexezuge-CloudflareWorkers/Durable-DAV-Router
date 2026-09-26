import type { D1Queryable, D1Result } from '../utils/D1Types';
import { executeD1WithRetry } from '../utils/D1Utils';

/**
 * Base for every D1 DAO in the router.
 *
 * It owns exactly one concern: retrying transient D1 faults. Everything else
 * (SQL text, binding order, result shaping) belongs to the concrete DAO, which
 * is the only place that knows its table's shape.
 */
abstract class BaseDAO {
  constructor(protected readonly database: D1Queryable) {}

  /**
   * Run a statement with bounded retries on transient faults.
   *
   * `context` names the operation so a failure is attributable in logs; it is
   * the only place D1's own message is allowed to become user-facing (via
   * `DatabaseError`), which is why it must be descriptive.
   */
  protected withRetry(operation: () => Promise<D1Result>, context: string): Promise<D1Result> {
    return executeD1WithRetry(operation, context);
  }
}

export { BaseDAO };
