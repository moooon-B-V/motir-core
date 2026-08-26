import { parseSleepMs } from './step';
import {
  parseEventExpression,
  resolveEventExpression,
  type EventExpressionTerm,
} from './eventExpression';

// THE ENGINE'S DEBOUNCE (Story MOTIR-3417 · Subtask MOTIR-3483).
//
// `defineJob`'s `debounce` option has been declared by `system.code-graph-refresh`
// and forwarded to Inngest since MOTIR-893, and the engine never had one: the
// dispatcher wrote `runAt: new Date()` for every subscriber, unconditionally.
// Moving the refresh to a lane without this would take a job whose whole point is
// "five pushes in a minute build ONE graph" and quietly make it build five — and
// every one of those runs SUCCEEDS, so the only signal is the invoice.
//
// ===========================================================================
// The mechanism was DECIDED, not invented here
// ===========================================================================
// `docs/decisions/job-queue-foundation.md` §9 chose it while rejecting pg-boss,
// whose `singleton`/throttle options were the strongest argument for adopting a
// library at all:
//
//   "Its semantics are 'hold until `period` passes with no further same-key
//    event, then run once with the latest' — a `run_at` that is pushed forward on
//    each same-key arrival, which is a column and an upsert on a table we own,
//    not a subsystem."
//
// This module is the arithmetic half of that sentence; `lib/jobs/engine/dispatcher.ts`
// is the upsert half and `job_queue.debounce_key` the column.
//
// ===========================================================================
// ⚠️ THE DEFERRAL CAP IS HONOURED HERE, AND INNGEST'S IS NOT — a deliberate,
// stated divergence
// ===========================================================================
// `timeout: '15m'` is meant to bound total deferral so a steady stream cannot
// defer a run forever. MOTIR-2994 MEASURED that on the Inngest dev server it does
// NOT fire for a stream faster than ~1 event/second — the run lands only once the
// stream stops, which is the exact case the option exists for. §9 calls that "a
// property of Inngest's implementation that we are free not to reproduce".
//
// Reproducing it correctly is two fields and a `Math.min`, so we do: the FIRST
// arrival is stamped on the row, and no later arrival may push `run_at` past
// `first_seen + timeout`. This is the one place the engine is deliberately
// STRICTER than what it replaces, and `docs/jobs.md` § Debounce records it beside
// MOTIR-2994's table so the difference is a decision rather than a discovery.

/** The option as a job declares it — Inngest's own shape, re-stated for the engine. */
export interface DebounceOption {
  /** An event expression (`lib/jobs/engine/eventExpression.ts`). */
  key: string;
  /** How long a same-key quiet period must last before the run becomes due. */
  period: string;
  /** Optional cap on TOTAL deferral, measured from the first arrival. */
  timeout?: string;
}

/**
 * Validate a `debounce` at REGISTRATION time — the expression AND both durations.
 *
 * Called from `defineJob`, so a job whose debounce the engine cannot evaluate
 * fails as its module is evaluated. The durations are parsed here for the same
 * reason the expression is: `parseSleepMs` throws on an unrecognised string, and
 * discovering that at DISPATCH would mean an event arriving on a request path and
 * failing to enqueue.
 */
export function parseDebounce(jobId: string, debounce: DebounceOption): void {
  parseEventExpression(jobId, 'debounce.key', debounce.key);
  parseDurationOrThrow(jobId, 'period', debounce.period);
  if (debounce.timeout !== undefined) {
    const timeoutMs = parseDurationOrThrow(jobId, 'timeout', debounce.timeout);
    const periodMs = parseDurationOrThrow(jobId, 'period', debounce.period);
    if (timeoutMs < periodMs) {
      // Not merely odd — it makes every run due at the cap on its FIRST arrival,
      // so the job is not debounced at all while reading as though it were.
      throw new Error(
        `Job "${jobId}" declares debounce.timeout (${debounce.timeout}) shorter than ` +
          `debounce.period (${debounce.period}). The cap would fire before the first quiet ` +
          `period could elapse, so nothing would ever coalesce.`,
      );
    }
  }
}

function parseDurationOrThrow(jobId: string, field: string, value: string): number {
  try {
    return parseSleepMs(value);
  } catch {
    throw new Error(
      `Job "${jobId}" declares debounce.${field}: ${JSON.stringify(value)}, which is not a ` +
        `duration the engine can parse. Use milliseconds, or a string like "30s" / "2m" / "15m".`,
    );
  }
}

/**
 * The coalescing key for ONE event, or `null` when the payload cannot supply one.
 *
 * `null` means *this event gets its own row* — not coalesced. That is the safe
 * direction, and the opposite of Inngest's: there an unresolvable key MERGES
 * every such event into one bucket, which is how unrelated repositories would be
 * indexed as one (`codeGraphRefresh.ts`'s own warning, measured by MOTIR-2994).
 * Losing coalescing costs money; merging loses events.
 */
export function resolveDebounceKey(
  debounce: DebounceOption | undefined,
  data: unknown,
  jobId: string,
): string | null {
  if (debounce === undefined) return null;
  const terms: EventExpressionTerm[] = parseEventExpression(jobId, 'debounce.key', debounce.key);
  return resolveEventExpression(terms, data);
}

/**
 * When a debounced run becomes due, given when its window was first opened.
 *
 * `now + period` is the quiet-period rule; `firstSeenAt + timeout` is the
 * deferral cap, and the earlier of the two wins. A cap already in the past yields
 * a `run_at` in the past, which is exactly right: the run is claimable on the
 * worker's next tick, which is what a cap firing MEANS.
 *
 * `firstSeenAt` is `null` for the first arrival, where there is nothing to cap
 * against yet.
 */
export function debouncedRunAt(
  debounce: DebounceOption,
  now: Date,
  firstSeenAt: Date | null,
): Date {
  const due = now.getTime() + parseSleepMs(debounce.period);
  if (debounce.timeout === undefined || firstSeenAt === null) return new Date(due);
  const cap = firstSeenAt.getTime() + parseSleepMs(debounce.timeout);
  return new Date(Math.min(due, cap));
}
