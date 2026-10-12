import { transactionTimeoutHalf } from './transactionStall';

/**
 * Run a READ-ONLY transaction once, retrying exactly once when Prisma could not
 * START it — the `maxWait` half of P2028, "Unable to start a transaction in the
 * given time" (MOTIR-8288).
 *
 * That half means the body never ran: no statement was sent and no lock was
 * taken, so re-running it in a FRESH transaction has no partial effect to
 * duplicate. In production it is the side effect of a stalled process — the
 * event loop blocked for ~12.9 s under host CPU steal, so the 2 s `maxWait`
 * timer expired while the pool still had idle connections — and one retry turns
 * that request from a page error into a slow success.
 *
 * The `timeout` half (the body started and ran out of time), any other error and
 * any SECOND `maxWait` failure propagate unchanged, so a genuinely exhausted
 * pool still surfaces. Never wrap a write with this: it is safe only because the
 * caller's transaction writes nothing. Same shape and reason as
 * `retryOnceOnUniqueRace` (`lib/savedFilters/retry.ts`).
 */
export async function retryOnceOnTransactionStart<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (transactionTimeoutHalf(err) === 'maxWait') {
      return run();
    }
    throw err;
  }
}
