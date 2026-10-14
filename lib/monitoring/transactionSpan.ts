import { performance } from 'node:perf_hooks';
import * as Sentry from '@sentry/nextjs';
import {
  poolOccupancySum,
  transactionTimeoutHalf,
  type PoolOccupancySum,
} from './transactionStall';

// EVERY INTERACTIVE TRANSACTION, MEASURED — AND TRACED WHEN THE REQUEST IS
// SAMPLED (MOTIR-8550).
//
// A P2028 says a transaction failed; it never said why a transaction that
// SUCCEEDED was slow. This module splits each attempt `retryOnceBeforeBody`
// makes into the two numbers that tell "the pool was empty" from "the query was
// slow":
//
//   WAIT  the helper asks for the transaction → `bodyStarted()`: pool acquire,
//         `BEGIN` and the `set_config` binds.
//   HOLD  `bodyStarted()` → the `db.$transaction` promise settles, at COMMIT or
//         ROLLBACK. NOT the attempt's own promise: `withAfterCommitScope` runs
//         deferred work between the two, after the connection is back in the
//         pool, and counting it would blame the connection for it.
//
// plus the pool's occupancy at the moment the helper asked — the queue this
// request joined.
//
// ⚠️ THE CLOCK IS OURS, NOT SENTRY'S. The numbers are taken with
// `performance.now()` and handed to every listener whether or not Sentry is
// initialised or the request was sampled: a head-sampled trace stream at a low
// production rate cannot give a p99, so the every-request recorder (MOTIR-8553)
// listens here. The spans are a VIEW of the same marks.
//
// ⚠️ THE STATEMENTS ARE PRISMA'S OWN SPANS, NOT A HOOK OF OURS. Sentry's default
// `Prisma` integration turns Prisma's tracing on, and Prisma (on the `pg` driver
// adapter) draws each statement as a `db` span whose name and `db.query.text` are
// the parameterised `$1…` SQL — never the bound values. Those spans nest under
// whatever span is active when the query is issued, which is why the binds run
// under WAIT and `bodyStarted(() => fn(tx))` runs the body under HOLD. Prisma's
// tracing reaches the client through a `globalThis` hook rather than a `require`
// patch, so it attaches in a bundled server as in a test. The SDK's `Postgres`
// integration, which would draw every statement a second time from inside `pg`,
// is removed in `serverSentryInitOptions` (`./serverInit`).
//
// ⚠️ THE LISTENER SET LIVES ON `globalThis`, under a `Symbol.for` key, for the
// reason the pool registry does (MOTIR-7007): the Next server evaluates a module
// once per Turbopack runtime, so a listener registered from one runtime's copy of
// this file must hear transactions opened through another's.

/** Which helper opened the transaction. */
export type TransactionContextLabel =
  | 'workspace'
  | 'workspace_service'
  | 'system'
  | 'bootstrap_slug'
  | 'user'
  | 'org'
  | 'org_service_write'
  | 'unlabelled';

/** How an attempt ended. */
export type TransactionOutcome =
  | 'committed'
  | 'rolled_back'
  /** P2028 before the body: no connection within `maxWait`. */
  | 'p2028_wait'
  /** P2028 before the body: a `set_config` bind ran on an expired transaction. */
  | 'p2028_timeout'
  | 'error_before_body';

export interface TransactionMeasurement {
  readonly context: TransactionContextLabel;
  /** 2 is the one retry `retryOnceBeforeBody` makes after a pre-body P2028. */
  readonly attempt: 1 | 2;
  /** Ask → `bodyStarted()`, or ask → failure when the body never started. */
  readonly waitMs: number;
  /** `bodyStarted()` → the transaction settled; null when the body never ran. */
  readonly holdMs: number | null;
  readonly outcome: TransactionOutcome;
  /** Summed over every registered pool when the helper asked. */
  readonly pool: PoolOccupancySum | 'unmeasured';
}

export type TransactionListener = (measurement: TransactionMeasurement) => void;

/** The span names and attribute keys — exported, like `STALL_TAG`, so the
 *  recorder, the integration gate and the end-to-end test read the same names. */
export const TRANSACTION_SPAN = {
  transaction: 'db.transaction',
  wait: 'db.transaction.wait',
  hold: 'db.transaction.hold',
  /** The `op` of a statement span — Prisma draws them. */
  statementOp: 'db',
} as const;

export const TRANSACTION_ATTR = {
  context: 'db.tx.context',
  attempt: 'db.tx.attempt',
  outcome: 'db.tx.outcome',
  waitMs: 'db.tx.wait_ms',
  holdMs: 'db.tx.hold_ms',
  poolTotal: 'db.pool.total',
  poolIdle: 'db.pool.idle',
  poolWaiting: 'db.pool.waiting',
  poolMax: 'db.pool.max',
  poolCount: 'db.pool.count',
  /** On a statement span (Prisma's): the parameterised text, `$1`-style. */
  statement: 'db.query.text',
} as const;

/**
 * True once `Sentry.init` has run in this process. Every span this module and
 * the MCP tool trace (`@/lib/mcp/toolTracing`) draw is behind it, so a build with
 * no DSN makes no Sentry span call at all. A throw reads as "not initialised": a
 * test that replaces the SDK with a partial mock must not fail a transaction.
 */
export function sentryIsInitialised(): boolean {
  try {
    return Sentry.getClient() !== undefined;
  } catch {
    return false;
  }
}

// ── Listeners ────────────────────────────────────────────────────────────────

const LISTENERS_KEY = Symbol.for('motir.transactionSpan.listeners');

type ListenerHolder = { [LISTENERS_KEY]?: Set<TransactionListener> };

function listeners(): Set<TransactionListener> {
  const holder = globalThis as ListenerHolder;
  holder[LISTENERS_KEY] ??= new Set();
  return holder[LISTENERS_KEY];
}

/** Hear every measured transaction attempt, in every runtime of this process.
 *  Returns the unsubscribe. */
export function onTransactionMeasured(listener: TransactionListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

function emit(measurement: TransactionMeasurement): void {
  for (const listener of listeners()) {
    try {
      listener(measurement);
    } catch (err) {
      // A measurement must never fail the transaction it measured.
      console.error('[transactionSpan] a measurement listener threw:', err);
    }
  }
}

// ── The attempt ──────────────────────────────────────────────────────────────

/**
 * What `retryOnceBeforeBody` hands an attempt. Called bare it marks the end of
 * WAIT; called with the body it marks it AND runs the body under the HOLD span,
 * so the body's statements nest there.
 */
export interface BodyStarted {
  (): void;
  <R>(body: () => R): R;
}

/** Marks the moment the `db.$transaction` promise settles — wrap that promise. */
export type TransactionSettled = <R>(transaction: Promise<R>) => Promise<R>;

export type MeasuredAttempt<T> = (
  bodyStarted: BodyStarted,
  settled: TransactionSettled,
) => Promise<T>;

/**
 * Run one attempt of a transaction, measured. `bodyStartedEver` reports
 * whether the attempt reached its body, which is what `retryOnceBeforeBody`'s
 * retry rule reads.
 */
export async function measureTransactionAttempt<T>(
  context: TransactionContextLabel,
  attempt: 1 | 2,
  run: MeasuredAttempt<T>,
  onBodyStarted: () => void,
): Promise<T> {
  const askedAt = performance.now();
  const pool = poolOccupancySum() ?? 'unmeasured';
  const tracing = sentryIsInitialised();

  let bodyAt: number | null = null;
  let settledAt: number | null = null;
  let holdSpan: Sentry.Span | undefined;
  let waitSpan: Sentry.Span | undefined;
  let txSpan: Sentry.Span | undefined;

  const bodyStarted = (<R>(body?: () => R): R | undefined => {
    if (bodyAt === null) {
      bodyAt = performance.now();
      onBodyStarted();
      waitSpan?.end();
      if (txSpan) {
        holdSpan = Sentry.startInactiveSpan({
          name: TRANSACTION_SPAN.hold,
          op: TRANSACTION_SPAN.hold,
          parentSpan: txSpan,
        });
      }
    }
    if (!body) return undefined;
    return holdSpan ? Sentry.withActiveSpan(holdSpan, body) : body();
  }) as BodyStarted;

  const settled: TransactionSettled = (transaction) =>
    transaction.finally(() => {
      settledAt ??= performance.now();
      holdSpan?.end();
    });

  const finish = (outcome: TransactionOutcome) => {
    const endAt = performance.now();
    const waitMs = (bodyAt ?? settledAt ?? endAt) - askedAt;
    const holdMs = bodyAt === null ? null : (settledAt ?? endAt) - bodyAt;
    const measurement: TransactionMeasurement = { context, attempt, waitMs, holdMs, outcome, pool };
    if (txSpan) {
      waitSpan?.end();
      holdSpan?.end();
      txSpan.setAttributes(spanAttributes(measurement));
      if (outcome !== 'committed') txSpan.setStatus({ code: 2, message: outcome });
    }
    emit(measurement);
  };

  const execute = async (): Promise<T> => {
    try {
      const result = await run(bodyStarted, settled);
      finish('committed');
      return result;
    } catch (err) {
      finish(failedOutcome(err, bodyAt !== null));
      throw err;
    }
  };

  if (!tracing) return execute();
  return Sentry.startSpan(
    {
      name: TRANSACTION_SPAN.transaction,
      op: TRANSACTION_SPAN.transaction,
      // A transaction outside any request (a job, a boot read) is not a trace
      // of its own — it only ever nests under one.
      onlyIfParent: true,
      attributes: { [TRANSACTION_ATTR.context]: context, [TRANSACTION_ATTR.attempt]: attempt },
    },
    (span) => {
      txSpan = span;
      waitSpan = Sentry.startInactiveSpan({
        name: TRANSACTION_SPAN.wait,
        op: TRANSACTION_SPAN.wait,
        parentSpan: span,
      });
      // The `set_config` binds run before `bodyStarted()`, so they nest under WAIT.
      return Sentry.withActiveSpan(waitSpan, execute);
    },
  );
}

function failedOutcome(err: unknown, bodyRan: boolean): TransactionOutcome {
  if (bodyRan) return 'rolled_back';
  const half = transactionTimeoutHalf(err);
  if (half === 'maxWait') return 'p2028_wait';
  if (half === 'timeout') return 'p2028_timeout';
  return 'error_before_body';
}

function spanAttributes(m: TransactionMeasurement): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    [TRANSACTION_ATTR.context]: m.context,
    [TRANSACTION_ATTR.attempt]: m.attempt,
    [TRANSACTION_ATTR.outcome]: m.outcome,
    [TRANSACTION_ATTR.waitMs]: Math.round(m.waitMs * 1000) / 1000,
  };
  if (m.holdMs !== null) attributes[TRANSACTION_ATTR.holdMs] = Math.round(m.holdMs * 1000) / 1000;
  if (m.pool === 'unmeasured') {
    attributes[TRANSACTION_ATTR.poolCount] = 'unmeasured';
  } else {
    attributes[TRANSACTION_ATTR.poolTotal] = m.pool.total;
    attributes[TRANSACTION_ATTR.poolIdle] = m.pool.idle;
    attributes[TRANSACTION_ATTR.poolWaiting] = m.pool.waiting;
    attributes[TRANSACTION_ATTR.poolMax] = m.pool.max;
    attributes[TRANSACTION_ATTR.poolCount] = m.pool.count;
  }
  return attributes;
}
