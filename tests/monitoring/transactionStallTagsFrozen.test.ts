import type { ErrorEvent } from '@sentry/nextjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTransactionStallPools,
  registerTransactionStallPool,
  STALL_TAG,
  stopTransactionStallMonitor,
  tagTransactionStall,
  type PoolOccupancy,
} from '@/lib/monitoring/transactionStall';

// THE P2028 TAG SET IS FROZEN (MOTIR-8556).
//
// The visibility story (MOTIR-8537) added transaction spans and pool sums beside
// the P2028 stall tags of MOTIR-6701 / MOTIR-7073, and promised not to change
// those tags: Motir stores an event's tags as the linked work item's evidence,
// so a renamed key or a re-meaning value silently breaks every stall card's
// reading.
//
// ⚠️ THE LITERAL BELOW WAS COPIED AT e855430 — the commit before the first of the
// story's five code cards (MOTIR-8549) landed — from
// `git show e855430:lib/monitoring/transactionStall.ts` (STALL_TAG, `poolTags`,
// `transactionStallTags`, `loopBlockTags`) and
// `git show e855430:lib/monitoring/processPressure.ts` (PROCESS_PRESSURE_TAG,
// whose tags `transactionStallTags` spreads in). A literal copied from the branch
// under test would freeze whatever the branch did. Do not regenerate it from the
// code: a deliberate change to the tag set edits this literal by hand, in a PR
// that says why.
//
// The inputs are fixed so every value is: two registered pools (so the sums and
// the busiest-pool pick both mean something), no event-loop monitor (so every
// window reading is `unmeasured`), and a fixed uptime.

const QUIET: PoolOccupancy = { totalCount: 3, idleCount: 3, waitingCount: 0, options: { max: 5 } };
// The busiest: the most waiters. `max` unset, so pg's default of 10 applies.
const STARVED: PoolOccupancy = { totalCount: 10, idleCount: 0, waitingCount: 4, options: {} };

const FROZEN_TAGS: Record<string, string> = {
  'tx.timeout_half': 'maxWait',
  'tx.event_loop_delay_max_ms': 'unmeasured',
  'tx.event_loop_delay_p99_ms': 'unmeasured',
  'tx.pool_total': '13',
  'tx.pool_idle': '3',
  'tx.pool_waiting': '4',
  'tx.pool_max': '15',
  'tx.pool_count': '2',
  'tx.pool_busiest_total': '10',
  'tx.pool_busiest_idle': '0',
  'tx.pool_busiest_waiting': '4',
  'tx.pool_busiest_max': '10',
  'tx.uptime_s': '4242',
  'tx.gc_pause_max_ms': 'unmeasured',
  'tx.gc_pause_total_ms': 'unmeasured',
  'tx.gc_major_count': 'unmeasured',
  'tx.heap_used_mb': 'unmeasured',
  'tx.heap_limit_mb': 'unmeasured',
  'tx.cgroup_nr_throttled': 'unmeasured',
  'tx.cgroup_throttled_ms': 'unmeasured',
  'tx.cpu_steal_ms': 'unmeasured',
  'tx.loop_block_ms': 'unmeasured',
  'tx.loop_block_frame': 'unmeasured',
  'tx.loop_block_age_s': 'unmeasured',
};

/** The STALL_TAG keys at e855430 — the positive control's list. */
const FROZEN_STALL_TAG_KEYS = [
  'tx.timeout_half',
  'tx.event_loop_delay_max_ms',
  'tx.event_loop_delay_p99_ms',
  'tx.pool_total',
  'tx.pool_idle',
  'tx.pool_waiting',
  'tx.pool_max',
  'tx.pool_count',
  'tx.pool_busiest_total',
  'tx.pool_busiest_idle',
  'tx.pool_busiest_waiting',
  'tx.pool_busiest_max',
  'tx.uptime_s',
  'tx.loop_block_ms',
  'tx.loop_block_frame',
  'tx.loop_block_age_s',
];

/** Prisma's maxWait half of P2028, as the engine words it. */
function p2028(): Error {
  return Object.assign(
    new Error(
      'Transaction API error: Unable to start a transaction in the given time. Timeout: 10000ms',
    ),
    { code: 'P2028' },
  );
}

beforeEach(() => {
  stopTransactionStallMonitor();
  clearTransactionStallPools();
  registerTransactionStallPool(QUIET);
  registerTransactionStallPool(STARVED);
  vi.spyOn(process, 'uptime').mockReturnValue(4242.2);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearTransactionStallPools();
});

describe('the P2028 stall tags, frozen at e855430', () => {
  it('tagTransactionStall produces exactly the frozen map, keys and values', () => {
    const event = { tags: { existing: 'kept' } } as unknown as ErrorEvent;
    const tagged = tagTransactionStall(event, { originalException: p2028() });
    expect(tagged.tags).toEqual({ existing: 'kept', ...FROZEN_TAGS });
  });

  it('STALL_TAG still exports every frozen key, so a rename fails here rather than vanishing from both sides', () => {
    const exported = new Set<string>(Object.values(STALL_TAG));
    for (const key of FROZEN_STALL_TAG_KEYS) expect(exported, key).toContain(key);
    // And every frozen STALL_TAG key is one of the produced tags.
    for (const key of FROZEN_STALL_TAG_KEYS) expect(Object.keys(FROZEN_TAGS)).toContain(key);
  });
});
