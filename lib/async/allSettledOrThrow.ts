/**
 * `Promise.all`'s result and shape, with `Promise.allSettled`'s discipline: every
 * promise is awaited to completion, and only then is the first rejection (in
 * ARRAY order) rethrown.
 *
 * WHY THIS EXISTS (MOTIR-3066). `Promise.all` rejects the instant ONE arm
 * rejects, and its siblings keep running with nobody awaiting them. For a fan-out
 * of pure computation that is harmless. For a fan-out of DATABASE work it is not:
 * each abandoned arm is an open transaction holding locks, and it holds them past
 * the point where the caller — a request handler, a test — believes the operation
 * is over.
 *
 * The concrete failure that produced this file: `workItemsService.getQuickView`
 * fanned out an access gate plus four bound reads. The gate rejects on the
 * ordinary 404 path (a foreign, unknown or deleted key), so on every refused peek
 * four interactive transactions were abandoned mid-flight. In the test suite the
 * next test's `TRUNCATE … CASCADE` reset then deadlocked against them (`40P01`),
 * killing a `beforeEach` in a file that had done nothing wrong. In production the
 * same arms hold pool connections and row locks after the response has been sent.
 *
 * Latency is unchanged on the happy path — the arms still run concurrently, and
 * the result is still one round trip. What changes is the refusal path, which now
 * costs as long as its slowest arm instead of leaving that arm running unobserved.
 * That is the intended trade: a refusal is rare, and "the operation is over when
 * the caller says it is over" is worth more than the microseconds.
 *
 * Rejections are rethrown in ARRAY order rather than in the order they arrived.
 * With the access gate written first, that makes the refusal a caller sees
 * deterministic — the gate's error, not whichever sibling happened to fail first.
 *
 * Use `Promise.all` freely for anything that holds no resource. Reach for this
 * whenever an arm opens a transaction, a connection, a file handle or a
 * subscription.
 */
export async function allSettledOrThrow<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<T> {
  const settled = await Promise.allSettled(promises);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') throw outcome.reason;
  }
  return settled.map(
    (outcome) => (outcome as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
}
