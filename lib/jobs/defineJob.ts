import type { JobServices } from './services';
import { resolveRetries, type RetryPolicyName } from './retries';
import type { CatchUpPolicy } from './catchUp';
import { registerSchedule } from './schedules';
import { registerEngineJob, type EngineJobDefinition } from './engine/registry';
import { registerJobManifest } from './engine/manifest';
import { parseIdempotencyTemplate } from './engine/idempotency';
import { parseDebounce, type DebounceOption } from './engine/debounce';
import type { createStepApi } from './engine/step';
import type { JobEventName } from './types';

// The canonical way to DECLARE a background job (Story 1.6 · Subtask 1.6.2,
// re-based onto the Postgres engine by Story MOTIR-3418).
//
// ⚠️ IT IS A REGISTRATION, NOT A WRAPPER — and that is the whole of what the
// Inngest retirement changed here. This function used to do two jobs: register
// the definition with the Postgres engine AND build an `inngest.createFunction`
// whose body carried the run-ledger bookkeeping. The second job is gone, because
// the lane it served is gone. The bookkeeping did not move — it was already
// duplicated, deliberately, in `lib/jobs/engine/ledger.ts` (`executeWithLedger`
// / `recordEngineTerminalFailure`), which is where a run's `running`, `succeeded`
// and dead-lettered rows have actually been written for every job since the
// cutover. So this file lost a second implementation of the ledger, not the
// ledger.
//
// WHAT IT DOES NOW, in order, all of it at MODULE-EVALUATION time:
//
//   1. publishes the cron to `lib/jobs/schedules.ts`, so
//      `jobScheduleHealthService` can tell that a scheduled job has stopped
//      firing (MOTIR-1970);
//   2. validates the `idempotency` and `debounce` templates, so a job the engine
//      cannot dedupe or coalesce fails LOUDLY at load rather than silently at
//      dispatch (MOTIR-3459 / MOTIR-3483);
//   3. registers the definition — handler included — with the engine registry,
//      and its handler-free view with the manifest the emit path reads.
//
// Every one of those happens at the ONE choke point a job definition must pass
// through, which is what keeps all four tables complete BY CONSTRUCTION: a job
// cannot exist without appearing in them.
//
// ⚠️ AND IT RETURNS THE REGISTERED DEFINITION. `lib/jobs/registry.ts` collects
// those returns into `jobDefinitions`, which is what the worker's side-effect
// import evaluates and what a test asserts a job's membership of. It used to
// return an opaque Inngest function object; the definition is the same fact in a
// readable shape — `id`, `trigger`, `cron`, `maxAttempts` are plain properties
// rather than accessors on an SDK object.

/** The `step` API the engine hands a handler — `lib/jobs/engine/step.ts`. */
export type JobStepApi = ReturnType<typeof createStepApi>;

/**
 * The context the engine hands a job handler.
 *
 * ⚠️ IT USED TO BE INFERRED FROM THE INNGEST SDK —
 * `Parameters<Parameters<typeof inngest.createFunction>[1]>[0]` — a large
 * structural type carrying members no engine could supply, which is why
 * `lib/jobs/engine/runner.ts` had to cast to it once at the boundary. That cast
 * is gone with the SDK: this IS the shape the engine builds, so the type a
 * handler is written against and the object it actually receives are now the
 * same declaration.
 *
 * The four members are the ones handlers in this tree read, measured rather than
 * assumed (`ctx.step` ×63, `ctx.event` ×28, `ctx.runId` ×11, `ctx.attempt` ×3);
 * `tests/jobs/engine-runner.test.ts` still asserts that surface against the tree,
 * so a handler reaching for a fifth member fails a test rather than throwing
 * inside a background job.
 */
export interface JobContext {
  event: { name: string; data: unknown; id?: string };
  step: JobStepApi;
  /** The `job_queue` row id — stable across a retry and a resume. */
  runId: string;
  /** ZERO-INDEXED, so a handler comparing against a retry budget reads as before. */
  attempt: number;
}

/**
 * A job handler: the business logic for one event. Receives the engine context
 * and the injected service-layer bag (4-layer rule — the handler is the
 * "service caller" for a background trigger). Its return value becomes the run's
 * resolved output on the ledger row.
 */
export type JobHandler = (ctx: JobContext, services: JobServices) => Promise<unknown> | unknown;

/**
 * The id/trigger pairing. An event's FIRST consumer uses the 1:1 convention
 * (the id IS the triggering event name). An event can only carry ONE definition
 * per id, so an ADDITIONAL consumer of an already-consumed event (e.g. the
 * 5.4.5 watcher job joining the 5.1.6 mention job on
 * `work-item/comment.created`) declares a distinct id plus an explicit
 * `trigger` naming the shared event. The trigger stays pinned to
 * `JobEventName` either way — that's the type-safety the 1:1 convention
 * existed to give.
 */
export type JobIdAndTrigger<N extends JobEventName> =
  | {
      /** The job id. Also the triggering event name (1:1 convention). */
      id: N;
      trigger?: undefined;
    }
  | {
      /** A distinct job id — this job is an ADDITIONAL consumer of `trigger`. */
      id: string;
      /** The (already-consumed) event this job subscribes to. */
      trigger: N;
    };

export type DefineJobOptions<N extends JobEventName> = JobIdAndTrigger<N> & {
  /**
   * Named retry policy (1.6.4) — the preferred way to declare retry INTENT.
   * `transient` (3 attempts), `idempotent` (5 attempts), `none` (1 attempt).
   * Mutually exclusive with `retries` (passing both throws). Default when
   * neither is given: `transient`.
   */
  retryPolicy?: RetryPolicyName;
  /** Raw count of ADDITIONAL attempts after the first. Escape hatch for an exact
   * number; prefer `retryPolicy`. Mutually exclusive with it. */
  retries?: number;
  /**
   * Optional idempotency key template, evaluated against the event payload
   * (e.g. `"event.data.idempotencyKey"`). Validated HERE at registration and
   * applied at ENQUEUE by `lib/jobs/engine/dispatcher.ts`, which enforces it
   * with the `(job_id, idempotency_key)` partial unique index (MOTIR-3459).
   */
  idempotency?: string;
  /**
   * Optional debounce (MOTIR-893, MOTIR-3483) — the run is deferred until
   * `period` has passed with no further same-`key` event, then runs ONCE with the
   * LATEST event. `key` is an event expression (e.g.
   * `"event.data.installationId"`); `timeout` caps the total deferral so a
   * steady stream cannot defer the run for ever.
   *
   * ⚠️ `key` MUST name fields the event payload type makes REQUIRED. It is a
   * string expression, so nothing type-checks it. The engine VALIDATES it here at
   * module evaluation — an expression it cannot parse throws at load rather than
   * silently merging unrelated events into one bucket, which is the shape that
   * bit MOTIR-2902 on the old scheduler. A field the payload does not carry means
   * "no coalescing for this event", never "one shared bucket".
   *
   * ⚠️ `timeout` IS a real cap here. The deferral is measured from the FIRST
   * arrival and honoured whatever the arrival rate — unlike the vendor scheduler
   * this replaced, where a stream faster than ~1 event/second defeated it
   * entirely (measured; `docs/decisions/job-lane-occupancy.md` § Debounce keeps
   * the numbers as a historical record of why the engine's cap is written the way
   * it is).
   *
   * A job that grows a `debounce` belongs in `tests/jobs/engine-debounce.test.ts`,
   * which drives the real dispatcher and counts the runs a burst produces.
   */
  debounce?: DebounceOption;
} & JobScheduleAndCatchUp;

/**
 * ⚠️ THE SCHEDULE AND ITS CATCH-UP DISPOSITION ARE ONE DECISION, so the type
 * makes them one field pair (Story MOTIR-3416 · Subtask MOTIR-3470;
 * `docs/decisions/job-queue-foundation.md` §11).
 *
 *   - a definition supplying `cron` **must** supply `catchUp`;
 *   - a definition supplying neither is an ordinary event-triggered job;
 *   - supplying `catchUp` WITHOUT `cron` is a type error, because the option is
 *     meaningless without a schedule and an accepted-but-ignored field is a lie.
 *
 * A two-arm union rather than an optional field, for the reason §11.8 records: a
 * DEFAULT is exactly how a cron job added next year inherits a disposition nobody
 * chose for it, and that is the failure the decision exists to prevent. The
 * pattern is already established one type up — `JobIdAndTrigger` is the same
 * shape, making `trigger` conditional on which arm the id takes.
 */
export type JobScheduleAndCatchUp =
  | {
      /**
       * Cron expression (1.6.4). When set, the job is SCHEDULED rather than
       * event-triggered: `lib/jobs/engine/scheduler.ts` turns the expression into
       * a `job_queue` row, and the ledger records the run's `event_name` as
       * `scheduled.{id}` so the dashboard treats scheduled + event-triggered runs
       * uniformly.
       */
      cron: string;
      /**
       * What the engine's scheduler owes this job for a fire the worker was down
       * across — `all` / `latest` / `skip` (`lib/jobs/catchUp.ts`). REQUIRED here
       * and nowhere else: declaring it beside the cron is what makes the policy
       * complete BY CONSTRUCTION, the same property `registerSchedule` and
       * `registerEngineJob` already depend on.
       *
       * ⚠️ It is NOT implied by `retryPolicy`. A retry says the handler may run
       * the same tick twice; this says whether a STALE tick is worth running.
       */
      catchUp: CatchUpPolicy;
    }
  | {
      cron?: undefined;
      catchUp?: undefined;
    };

/**
 * Declare one background job. Returns the registered definition, which
 * `lib/jobs/registry.ts` collects.
 */
export function defineJob<N extends JobEventName>(
  options: DefineJobOptions<N>,
  handler: JobHandler,
): EngineJobDefinition {
  const { id, idempotency, debounce, cron, catchUp } = options;
  // Publish the schedule so `jobScheduleHealthService` can check that this cron
  // is still actually firing in production (MOTIR-1970). Registering HERE, at
  // the single choke point every job passes through, is what keeps the schedule
  // table complete by construction — a cron job cannot exist without appearing
  // in it.
  if (cron !== undefined) registerSchedule(id, cron);
  // The event this job subscribes to: the id itself (1:1 convention) or the
  // explicit `trigger` of an additional consumer. A cron job subscribes to
  // nothing.
  const triggerEvent = options.trigger ?? id;
  const engineTrigger = cron !== undefined ? undefined : triggerEvent;
  // Resolve the retry budget once (throws if both retryPolicy and retries are
  // given). `resolveRetries` counts ADDITIONAL attempts, the engine counts TOTAL
  // attempts — which is what `job_queue.max_attempts` stores and what
  // `lib/jobs/retries.ts` states its policies in. +1 is that translation, in the
  // one place it happens.
  const maxAttempts = resolveRetries(options) + 1;

  // ⚠️ VALIDATE THE TEMPLATES HERE, as the definition module is evaluated, so a
  // job the engine cannot dedupe fails loudly at load rather than silently
  // stopping deduplication at dispatch (MOTIR-3459) — and the same for the
  // debounce key and both its durations (MOTIR-3483), which would otherwise
  // surface at DISPATCH, i.e. on a request path, as an event that failed to
  // enqueue.
  if (idempotency !== undefined) parseIdempotencyTemplate(id, idempotency);
  if (debounce !== undefined) parseDebounce(id, debounce);

  const definition: EngineJobDefinition = {
    id,
    trigger: engineTrigger,
    cron,
    maxAttempts,
    retryPolicy: options.retryPolicy,
    idempotency,
    catchUp,
    debounce,
    handler,
  };

  registerEngineJob(definition);

  // …and the HANDLER-FREE view of the same registration, for the emit path
  // (MOTIR-3458, ADR §12). Registered HERE, beside its sibling, so the two
  // cannot drift: a job cannot be defined without appearing in both.
  registerJobManifest({
    id,
    trigger: engineTrigger,
    cron,
    maxAttempts,
    retryPolicy: options.retryPolicy,
    idempotency,
    debounce,
  });

  return definition;
}

/** Re-exported so a caller holding a definition can reach its type in one import. */
export type { EngineJobDefinition };
