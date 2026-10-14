import { transactionTimeoutHalf } from '@/lib/monitoring/transactionStall';
import {
  measureTransactionAttempt,
  type MeasuredAttempt,
  type TransactionContextLabel,
} from '@/lib/monitoring/transactionSpan';

/**
 * Open a bound transaction, retrying it ONCE in a fresh transaction when Prisma
 * failed it with P2028 BEFORE the caller's body started (MOTIR-8333).
 *
 * `attempt` opens the transaction and calls `bodyStarted()` immediately before
 * it hands control to the caller's `fn` — after the transaction-local
 * `set_config` binds and nothing else. Until that call, the transaction has done
 * nothing but bind GUCs that die with it, so a fresh attempt duplicates nothing,
 * whether the caller goes on to read or to write.
 *
 * Both halves of P2028 are retried on that side of the line:
 *   * `maxWait` — "Unable to start a transaction in the given time" (MOTIR-8288);
 *   * `timeout` — "A query cannot be executed on an expired transaction", raised
 *     by a `set_config` bind. In production (2026-10-12T17:36Z) the authed
 *     layout's `listProjects` transaction expired 8 241 ms in, on its FIRST bind:
 *     the process was stalled under host CPU steal (MOTIR-8296), not the query.
 *
 * Once `bodyStarted()` has run, nothing is retried: the body may have written,
 * and only the caller knows whether re-running it is safe. Any other error, and
 * a SECOND failure, propagate unchanged, so a genuinely exhausted pool still
 * surfaces.
 *
 * `context` names the helper that opened it, for the measurement. An attempt
 * marks the end of its WAIT by calling `bodyStarted()` — or
 * `bodyStarted(() => fn(tx))`, which also runs the body under the HOLD span —
 * and wraps its `db.$transaction(...)` promise in `settled(...)` so the HOLD
 * ends when the transaction does, not after any after-commit work.
 */
export async function retryOnceBeforeBody<T>(
  attempt: MeasuredAttempt<T>,
  context: TransactionContextLabel = 'unlabelled',
): Promise<T> {
  // Every attempt is measured and, on a sampled request, traced — wait, hold and
  // pool occupancy (MOTIR-8550, `@/lib/monitoring/transactionSpan`). The first
  // attempt is recorded even when it is the one that gets retried, which is how
  // a load test sees how often the retry fires. The retry rule is unchanged.
  let started = false;
  const markStarted = () => {
    started = true;
  };
  try {
    return await measureTransactionAttempt(context, 1, attempt, markStarted);
  } catch (err) {
    if (started || transactionTimeoutHalf(err) === null) throw err;
    return measureTransactionAttempt(context, 2, attempt, () => {});
  }
}
