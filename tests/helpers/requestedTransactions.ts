import { vi } from 'vitest';
import { db } from '@/lib/db';

/**
 * Wrap `db.$transaction` and record the peak number of interactive transactions
 * REQUESTED at once — counted from the call, not from the callback, because the
 * pool demand starts when the caller asks for a connection. Counting inside the
 * callback measures only the ones that already got one, which is what a starved
 * pool hides.
 *
 * `total` is every interactive transaction requested over the tracker's life, so
 * a test can also assert that a path opens NONE of its own.
 *
 * MOTIR-6627 wrote it for the public overview; MOTIR-6653 lifted it here for the
 * public board and `workflowsService.listStatusesByProject`. The spy is undone
 * by `vi.restoreAllMocks()` in the caller's `afterEach`.
 */
export function trackRequestedTransactions(): { peak: () => number; total: () => number } {
  const original = db.$transaction.bind(db);
  let inFlight = 0;
  let peak = 0;
  let total = 0;
  vi.spyOn(db, '$transaction').mockImplementation(((arg: unknown, options?: unknown) => {
    // Only the interactive (callback) form holds a connection across awaits.
    if (typeof arg !== 'function') return original(arg as never, options as never);
    inFlight += 1;
    total += 1;
    peak = Math.max(peak, inFlight);
    return original(arg as never, options as never).finally(() => {
      inFlight -= 1;
    });
  }) as typeof db.$transaction);
  return { peak: () => peak, total: () => total };
}
