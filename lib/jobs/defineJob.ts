import { inngest } from './client';
import { jobServices, type JobServices } from './services';
import { resolveRetries, type RetryPolicyName } from './retries';
import { jobRunsService } from '@/lib/services/jobRunsService';
import type { JobEventName } from './types';
import type { JobRunFailure } from '@/lib/dto/jobs';
import type { Prisma } from '@prisma/client';

// The canonical wrapper around `inngest.createFunction` (Story 1.6 · Subtask
// 1.6.2, extended in 1.6.4). Every background job is defined through this —
// never the raw SDK — so the run-ledger bookkeeping (the read path the 1.6.5
// dashboard renders) is automatic and uniform.
//
// What the wrapper adds around the user handler:
//   1. writes a `running` job_run row at start (capturing workspaceId from the
//      event payload, attempt, event name/id);
//   2. on success → flips the row to `succeeded`;
//   3. on the FINAL failed attempt (retry budget exhausted) → in one
//      transaction, flips the row to `failed` AND writes a job_run_dlq row,
//      THEN re-throws so Inngest still sees the failure.
//
// The bookkeeping writes run inside `step.run(...)`, which Inngest memoizes:
// each runs EXACTLY ONCE even though the handler body is re-invoked at every
// step boundary (durable-execution replay), and the `job-run:start` step's
// memoized result is reused across RETRIES (so it's one row per run, not per
// attempt — multi-step jobs like email.send keep a single ledger row).
//
// RETRY/DLQ SEMANTICS (1.6.4). `ctx.attempt` is Inngest's zero-indexed attempt
// number. The retry budget (`maxRetries`, from `retryPolicy` or `retries`) is
// captured in the closure, so the catch can tell whether THIS is the final
// attempt (`ctx.attempt >= maxRetries`). Only the final attempt writes anything
// on failure: earlier attempts just re-throw, leaving the row `running` so the
// dashboard shows a retrying run as in-flight rather than prematurely failed.
// That also sidesteps the memoization trap — a per-attempt `job-run:failed`
// step would memoize on attempt 0 and never re-run, so it could not observe the
// final attempt; the single `job-run:dead-letter` step only ever executes on
// the final attempt, so it has no stale memo to collide with.

/**
 * The context Inngest hands a function handler, inferred from the client so an
 * SDK upgrade keeps this in sync. Carries `event`, `step`, `runId`, `attempt`,
 * `logger`, etc.
 */
export type JobContext = Parameters<Parameters<typeof inngest.createFunction>[1]>[0];

/**
 * A job handler: the business logic for one event. Receives the Inngest
 * context and the injected service-layer bag (4-layer rule — the handler is
 * the "service caller" for a background trigger). Its return value becomes the
 * run's resolved output.
 */
export type JobHandler = (ctx: JobContext, services: JobServices) => Promise<unknown> | unknown;

export interface DefineJobOptions<N extends JobEventName> {
  /** The job id. Also the triggering event name (1:1 convention). */
  id: N;
  /**
   * Named retry policy (1.6.4) — the preferred way to declare retry INTENT.
   * `transient` (3 attempts), `idempotent` (5 attempts), `none` (1 attempt).
   * Mutually exclusive with `retries` (passing both throws). Default when
   * neither is given: `transient`.
   */
  retryPolicy?: RetryPolicyName;
  /** Raw Inngest retry count (additional attempts after the first). Escape
   * hatch for an exact number; prefer `retryPolicy`. Mutually exclusive with it. */
  retries?: number;
  /** Optional concurrency limit (max simultaneous runs). */
  concurrency?: number;
  /**
   * Optional idempotency key template, evaluated against the event payload
   * (e.g. `"event.data.idempotencyKey"`). Forwarded to Inngest, which dedups
   * same-key events inside its window.
   */
  idempotency?: string;
  /**
   * Optional cron expression (1.6.4). When set, the job is SCHEDULED rather
   * than event-triggered: Inngest invokes it on the cron, and the wrapper
   * records the ledger row's `event_name` as `scheduled.{id}` so the dashboard
   * treats scheduled + event-triggered runs uniformly.
   */
  cron?: string;
}

/** Serialize an unknown thrown value into the JobRunFailure wire shape. */
function serializeFailure(err: unknown): JobRunFailure {
  if (err instanceof Error) {
    const failure: JobRunFailure = { message: err.message };
    if (err.stack) failure.stack = err.stack;
    const maybeCode = (err as { code?: unknown }).code;
    if (typeof maybeCode === 'string') failure.code = maybeCode;
    return failure;
  }
  return { message: String(err) };
}

export function defineJob<N extends JobEventName>(
  options: DefineJobOptions<N>,
  handler: JobHandler,
) {
  const { id, concurrency, idempotency, cron } = options;
  // Resolve the retry budget once (throws if both retryPolicy and retries are
  // given). Used BOTH for Inngest's config and for the final-attempt check below.
  const maxRetries = resolveRetries(options);

  // event name === id (the 1:1 convention) for event-triggered jobs; a cron job
  // uses a `{ cron }` trigger instead. 2-arg createFunction form: triggers live
  // in the options object, NOT a third argument (the legacy 3-arg form throws at
  // import in inngest@4.5 — finding #30 sharp edge #1). The cast pins
  // `retries: number` into Inngest's 0..20 literal union; our public API stays a
  // friendly `number` and the type-safety we care about (the `id` ∈
  // JobEventName) is enforced at the DefineJobOptions boundary above.
  const config = {
    id,
    retries: maxRetries,
    triggers: cron !== undefined ? [{ cron }] : [{ event: id }],
    ...(concurrency !== undefined ? { concurrency: { limit: concurrency } } : {}),
    ...(idempotency !== undefined ? { idempotency } : {}),
  } as Parameters<typeof inngest.createFunction>[0];

  return inngest.createFunction(config, async (ctx: JobContext) => {
    const { event, step } = ctx;
    const data = event.data as { workspaceId?: string | null; idempotencyKey?: string } | undefined;
    const workspaceId = data?.workspaceId ?? null;
    // Record the idempotency key the run executed under (when the event carries
    // one) so the operator dashboard (1.6.5) can show it. The dedup that READS
    // it to skip a duplicate run is Inngest's own event-level dedup, configured
    // per-job via the `idempotency` option above.
    const idempotencyKey = data?.idempotencyKey ?? null;
    // A scheduled (cron) job has no real triggering event name — Inngest hands
    // it an internal scheduled-timer event — so synthesize `scheduled.{id}` for
    // the ledger, making scheduled runs uniform with event-triggered ones.
    const eventName = cron !== undefined ? `scheduled.${id}` : event.name;
    // The triggering event's id correlates the run to its event; fall back to
    // the runId when the event carries no id (cron / test-harness events).
    const eventId = event.id ?? ctx.runId;

    const jobRun = await step.run('job-run:start', () =>
      jobRunsService.recordStart({
        workspaceId,
        functionId: id,
        eventName,
        eventId,
        attempt: ctx.attempt,
        idempotencyKey,
      }),
    );

    try {
      const result = await handler(ctx, jobServices);
      await step.run('job-run:succeeded', () => jobRunsService.recordSuccess(jobRun.id));
      return result;
    } catch (err) {
      const failure = serializeFailure(err);
      const isFinalAttempt = ctx.attempt >= maxRetries;
      if (isFinalAttempt) {
        // Retry budget exhausted: flip to failed + dead-letter in one tx. The
        // original event payload is persisted so the entry is replayable.
        await step.run('job-run:dead-letter', () =>
          jobRunsService.recordFailureAndDeadLetter(jobRun.id, failure, {
            eventData: (event.data ?? {}) as Prisma.InputJsonValue,
            attempts: ctx.attempt + 1,
          }),
        );
      }
      // Re-throw on every attempt so Inngest's retry machinery still sees the
      // failure (and stops once the budget — which it shares — is exhausted).
      throw err;
    }
  });
}
