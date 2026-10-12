import { transactionTimeoutHalf } from '@/lib/monitoring/transactionStall';

/**
 * Run a READ-ONLY transaction once, retrying exactly once when it could not
 * START — Prisma's `maxWait` half of P2028, "Unable to start a transaction in
 * the given time" (MOTIR-8288).
 *
 * That half means the transaction never began: no statement ran, nothing was
 * read and nothing was written, so a second attempt has no partial effect to
 * duplicate. In production it is what a process-level stall leaves behind — the
 * event loop blocked ~12.9 s (`not_in_js`) under heavy CPU steal while the pool
 * had connections free, so the 2 s `maxWait` expired before the process could
 * run the acquire-and-start sequence at all. The request that would have died
 * at the front door answers late instead.
 *
 * The retry is a FRESH transaction (a start that failed cannot be resumed in
 * place — the same shape as `retryOnceOnUniqueRace`), and any second failure
 * propagates unchanged. So a genuinely starved pool still surfaces: it fails
 * the retry too, and its P2028 reaches the monitor exactly as before.
 *
 * ⚠️ ONLY FOR A TRANSACTION THAT WRITES NOTHING AND TAKES NO LOCK. Never wrap a
 * write path with it, never `withUserContext` as a whole, and never the
 * `timeout` half (a transaction that started and then expired is a different
 * failure, and its body may already have run).
 */
export async function retryOnceOnTransactionStartTimeout<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (transactionTimeoutHalf(err) === 'maxWait') return run();
    throw err;
  }
}
