import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { ErrorEvent, EventHint } from '@sentry/nextjs';

// WHAT A TRANSACTION TIMEOUT WAS WAITING ON (MOTIR-6701).
//
// Prisma's P2028 has two halves: "Unable to start a transaction in the given
// time" (the `maxWait` for a pooled connection ran out) and "A commit cannot be
// executed on an expired transaction" (the `timeout` ran out mid-body). The
// stack trace names whichever code happened to be waiting, and in production that
// has repeatedly been code doing almost nothing: a `set_config` plus a
// primary-key read expired after 10 s on `GET /api/plans/[id]`, while other
// trivial transactions on other routes failed in the same minute on the same
// machine. The frame is where a stall SURFACED, not what caused it.
//
// Three causes fit that symptom and nothing recorded could tell them apart:
//   - the Node EVENT LOOP was blocked, so no query callback could run;
//   - the pg POOL was exhausted, so no connection was free;
//   - the DATABASE (or a lock) stalled, so a statement sat unanswered.
// This module attaches the three readings that separate them — event-loop delay,
// pool occupancy, process uptime — as TAGS on the P2028's own event. Tags rather
// than context because Motir stores an event's tags as the linked work item's
// evidence, so whoever fixes the stall reads the cause from the card.
//
// ⚠️ IT OBSERVES AND CHANGES NOTHING. No budget, no pool size and no retry is
// touched here; a reading that altered what it measures would be worthless.
//
// ⚠️ AND IT NEVER IMPORTS `@/lib/db`. This module is reached from the Sentry init
// that runs at server boot, before any request and possibly without a
// `DATABASE_URL` at all (a build). `lib/db.ts` hands its pool IN instead
// (`registerTransactionStallPool`), so a process that never touched the database
// simply reports no pool.
//
// ⚠️ THE POOL TAGS DESCRIBE EVERY POOL IN THE PROCESS, NOT ONE (MOTIR-7073). The
// Next server evaluates `lib/db.ts` once per Turbopack runtime — route handlers
// and pages are two — and each evaluation builds its own client and pool. So
// `tx.pool_total` / `tx.pool_idle` / `tx.pool_waiting` / `tx.pool_max` are SUMS
// over every registered pool (identical to MOTIR-6701's meaning wherever there is
// one pool: the job worker, a script, a test), `tx.pool_count` says how many were
// summed, and the `tx.pool_busiest_*` tags give the one pool with the most
// waiters (then the most connections in use), which is where starvation shows.

/** The two halves of P2028, named for the Prisma option that ran out. */
export type TransactionTimeoutHalf = 'maxWait' | 'timeout';

/** What `lib/db.ts` hands in — the occupancy counters of a `pg.Pool`. */
export interface PoolOccupancy {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly options: { readonly max?: number };
  /** `pg.Pool` sets it once `end()` has run; such a pool is no longer reported. */
  readonly ended?: boolean;
}

const P2028 = 'P2028';
const MAX_WAIT_MESSAGE = /Unable to start a transaction in the given time/i;
const TRANSACTION_API_MESSAGE = /Transaction API error/i;

/**
 * The P2028 half `err` carries — walking its `cause` chain, since a translated
 * error may carry the Prisma one as its cause — or null when it is not a
 * transaction timeout at all.
 */
export function transactionTimeoutHalf(err: unknown): TransactionTimeoutHalf | null {
  let current = err;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (candidate.code === P2028 || TRANSACTION_API_MESSAGE.test(message)) {
      return MAX_WAIT_MESSAGE.test(message) ? 'maxWait' : 'timeout';
    }
    current = candidate.cause;
  }
  return null;
}

// ── Event-loop delay ─────────────────────────────────────────────────────────
//
// One histogram per process, rolled every WINDOW_MS: the reading is the worse of
// the current window and the one before it, so a stall that ended moments before
// a roll is still reported. A blocked loop cannot roll the window either — the
// timer that would do it is one of the callbacks being starved — so the block
// always lands in the window that reports it.

const WINDOW_MS = 30_000;
const RESOLUTION_MS = 10;
const NS_PER_MS = 1_000_000;

interface DelayWindow {
  readonly maxMs: number;
  readonly p99Ms: number;
}

interface LoopMonitor {
  readonly histogram: IntervalHistogram;
  readonly timer: NodeJS.Timeout;
  previous: DelayWindow | null;
}

let loopMonitor: LoopMonitor | null = null;
function snapshot(histogram: IntervalHistogram): DelayWindow | null {
  if (histogram.count === 0) return null;
  return {
    maxMs: histogram.max / NS_PER_MS,
    p99Ms: histogram.percentile(99) / NS_PER_MS,
  };
}

/**
 * Start measuring event-loop delay. Idempotent. Called ONLY where `Sentry.init`
 * is — the server's Sentry config and the job worker — so a self-hosted build
 * with no DSN starts no monitor, exactly as it installs no integration.
 */
export function startTransactionStallMonitor(): void {
  if (loopMonitor) return;
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const monitor: LoopMonitor = {
    histogram,
    previous: null,
    timer: setInterval(() => {
      monitor.previous = snapshot(histogram);
      histogram.reset();
    }, WINDOW_MS),
  };
  // Never keep a process alive for a measurement.
  monitor.timer.unref();
  loopMonitor = monitor;
}

/** Stop the monitor and forget every reading — for tests. */
export function stopTransactionStallMonitor(): void {
  if (!loopMonitor) return;
  clearInterval(loopMonitor.timer);
  loopMonitor.histogram.disable();
  loopMonitor = null;
}

/** True when {@link startTransactionStallMonitor} has run in this process. */
export function isTransactionStallMonitorRunning(): boolean {
  return loopMonitor !== null;
}

function readEventLoopDelay(): DelayWindow | null {
  if (!loopMonitor) return null;
  const current = snapshot(loopMonitor.histogram);
  const previous = loopMonitor.previous;
  if (!current) return previous;
  if (!previous) return current;
  return {
    maxMs: Math.max(current.maxMs, previous.maxMs),
    p99Ms: Math.max(current.p99Ms, previous.p99Ms),
  };
}

// ── Pool occupancy ───────────────────────────────────────────────────────────
//
// ⚠️ ONE REGISTRATION PER PROCESS, NOT PER MODULE INSTANCE (MOTIR-7007). Next
// compiles `instrumentation.ts` into a DIFFERENT module graph from the route
// handlers, so this file is evaluated more than once in one server process.
// `lib/db.ts` — reached from a route — registers its pool in one evaluation; the
// Sentry `beforeSend` — installed by `sentry.server.config.ts`, reached from
// instrumentation — reads another. With a module-level `let`, every production
// P2028 reported the pool as `unmeasured` beside numeric event-loop tags. So the
// registration lives on `globalThis` under a registered symbol, the shape
// `lib/blob/s3.ts` and `lib/monitors/providers/fake.ts` (MOTIR-5734) already use
// for the same boundary.
//
// The event-loop monitor above stays module-local ON PURPOSE: in both runtimes it
// is started and read in the same evaluation (the server's Sentry config, the
// worker's single bundle), and `tests/monitoring/sentry-init-gate.test.ts` relies
// on `vi.resetModules()` discarding a monitor an earlier case started.
//
// ⚠️ AND THE REGISTRATION IS A SET, NOT A SLOT (MOTIR-7073). The WRITER is
// evaluated more than once too: `lib/db.ts` runs once per Turbopack runtime, each
// run building its own pool, so a single slot kept whichever runtime evaluated
// last, and a route handler's P2028 reported a page runtime's idle pool
// (0 total / 0 waiting, which the pool a `maxWait` timeout was waiting on cannot
// be). Registering adds; nothing replaces.

const POOLS_KEY = Symbol.for('motir.transactionStall.pools');

type PoolHolder = { [POOLS_KEY]?: Set<PoolOccupancy> };

function poolRegistry(): Set<PoolOccupancy> {
  const holder = globalThis as PoolHolder;
  holder[POOLS_KEY] ??= new Set();
  return holder[POOLS_KEY];
}

/** The pools still open, forgetting any that have ended (a `$disconnect()`). */
function registeredPools(): PoolOccupancy[] {
  const registry = poolRegistry();
  for (const pool of registry) if (pool.ended) registry.delete(pool);
  return [...registry];
}

/**
 * Add a pool `lib/db.ts` built, so a report can read its occupancy. Every
 * evaluation of `lib/db.ts` in the process adds its own; the same pool twice
 * (the dev hot-reload singleton) is counted once.
 */
export function registerTransactionStallPool(pool: PoolOccupancy): void {
  poolRegistry().add(pool);
}

/** Forget every registered pool — for tests. */
export function clearTransactionStallPools(): void {
  poolRegistry().clear();
}

// ── The tags ─────────────────────────────────────────────────────────────────

/** The tag keys, exported so the follow-up reading them and the tests agree. */
export const STALL_TAG = {
  half: 'tx.timeout_half',
  loopMaxMs: 'tx.event_loop_delay_max_ms',
  loopP99Ms: 'tx.event_loop_delay_p99_ms',
  poolTotal: 'tx.pool_total',
  poolIdle: 'tx.pool_idle',
  poolWaiting: 'tx.pool_waiting',
  poolMax: 'tx.pool_max',
  poolCount: 'tx.pool_count',
  busiestTotal: 'tx.pool_busiest_total',
  busiestIdle: 'tx.pool_busiest_idle',
  busiestWaiting: 'tx.pool_busiest_waiting',
  busiestMax: 'tx.pool_busiest_max',
  uptimeS: 'tx.uptime_s',
} as const;

/** What a reading reports when there is nothing to read — never a zero, which
 *  would claim a healthy loop or an empty pool that nobody measured. */
const UNMEASURED = 'unmeasured';

// pg's own default, applied by `pg-pool` when no `max` is configured.
const PG_DEFAULT_POOL_MAX = 10;

function poolMax(pool: PoolOccupancy): number {
  return pool.options.max ?? PG_DEFAULT_POOL_MAX;
}

/** The pool with the most waiters, then the most connections in use. */
function busiestPool(pools: readonly PoolOccupancy[]): PoolOccupancy {
  const inUse = (pool: PoolOccupancy) => pool.totalCount - pool.idleCount;
  return pools.reduce((busiest, pool) =>
    pool.waitingCount > busiest.waitingCount ||
    (pool.waitingCount === busiest.waitingCount && inUse(pool) > inUse(busiest))
      ? pool
      : busiest,
  );
}

function poolTags(pools: readonly PoolOccupancy[]): Record<string, string> {
  if (pools.length === 0) {
    return Object.fromEntries(
      [
        STALL_TAG.poolTotal,
        STALL_TAG.poolIdle,
        STALL_TAG.poolWaiting,
        STALL_TAG.poolMax,
        STALL_TAG.poolCount,
        STALL_TAG.busiestTotal,
        STALL_TAG.busiestIdle,
        STALL_TAG.busiestWaiting,
        STALL_TAG.busiestMax,
      ].map((key) => [key, UNMEASURED]),
    );
  }
  const sum = (read: (pool: PoolOccupancy) => number) =>
    String(pools.reduce((total, pool) => total + read(pool), 0));
  const busiest = busiestPool(pools);
  return {
    [STALL_TAG.poolTotal]: sum((pool) => pool.totalCount),
    [STALL_TAG.poolIdle]: sum((pool) => pool.idleCount),
    [STALL_TAG.poolWaiting]: sum((pool) => pool.waitingCount),
    [STALL_TAG.poolMax]: sum(poolMax),
    [STALL_TAG.poolCount]: String(pools.length),
    [STALL_TAG.busiestTotal]: String(busiest.totalCount),
    [STALL_TAG.busiestIdle]: String(busiest.idleCount),
    [STALL_TAG.busiestWaiting]: String(busiest.waitingCount),
    [STALL_TAG.busiestMax]: String(poolMax(busiest)),
  };
}

/**
 * The stall tags for a transaction-timeout `err`, or null when `err` is not one.
 * Values are strings (Sentry tags are); a number is whole ms / whole seconds.
 */
export function transactionStallTags(err: unknown): Record<string, string> | null {
  const half = transactionTimeoutHalf(err);
  if (!half) return null;
  const loop = readEventLoopDelay();
  return {
    [STALL_TAG.half]: half,
    [STALL_TAG.loopMaxMs]: loop ? String(Math.round(loop.maxMs)) : UNMEASURED,
    [STALL_TAG.loopP99Ms]: loop ? String(Math.round(loop.p99Ms)) : UNMEASURED,
    ...poolTags(registeredPools()),
    [STALL_TAG.uptimeS]: String(Math.round(process.uptime())),
  };
}

/**
 * A Sentry event processor: adds the stall tags to an event whose exception is
 * a transaction timeout, and returns every other event unchanged.
 */
export function tagTransactionStall(event: ErrorEvent, hint: EventHint): ErrorEvent {
  const tags = transactionStallTags(hint.originalException);
  if (!tags) return event;
  return { ...event, tags: { ...event.tags, ...tags } };
}
