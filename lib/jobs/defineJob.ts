import type { ConcurrencyOption } from 'inngest/types';
import { inngest } from './client';
import { jobServices, type JobServices } from './services';
import { resolveRetries, type RetryPolicyName } from './retries';
import type { CatchUpPolicy } from './catchUp';
import { registerSchedule } from './schedules';
import { registerEngineJob } from './engine/registry';
import { registerJobManifest } from './engine/manifest';
import { parseIdempotencyTemplate } from './engine/idempotency';
import { parseDebounce, type DebounceOption } from './engine/debounce';
import { routedToEngine } from './engine/cutover';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { alertTerminalJobFailure } from '@/lib/monitoring/jobFailureAlert';
import type { JobEventName } from './types';
import type { JobRunFailure } from '@/lib/dto/jobs';
import type { Prisma } from '@/generated/prisma/client';

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

/**
 * The shape of the argument Inngest passes a function's `onFailure` handler
 * (1.6.6). `event` is the internal `inngest/function.failed` payload — it nests
 * the ORIGINAL triggering event under `data.event`, plus the failed `run_id`
 * and the final `error`. We only read the few fields the dead-letter write
 * needs; `step` is the same step API as the main handler, used to make the
 * dead-letter write durable across an onFailure retry.
 */
export interface FailureHandlerArgs {
  event: {
    data: {
      run_id: string;
      error?: unknown;
      event: { id?: string; name?: string; data?: unknown };
    };
  };
  error: Error;
  step: JobContext['step'];
}

/**
 * The id/trigger pairing. An event's FIRST consumer uses the 1:1 convention
 * (the id IS the triggering event name). An event can only carry ONE function
 * per id, so an ADDITIONAL consumer of an already-consumed event (e.g. the
 * 5.4.5 watcher job joining the 5.1.6 mention job on
 * `work-item/comment.created`) declares a distinct id plus an explicit
 * `trigger` naming the shared event. The trigger stays pinned to
 * `JobEventName` either way — that's the type-safety the 1:1 convention
 * existed to give.
 */
/**
 * Inngest's own concurrency-constraint shape, re-exported so a job definition
 * can type a constraint without reaching into `inngest/types` itself
 * (`{ limit, key?, scope? }` — see the `concurrency` option below).
 */
export type { ConcurrencyOption };

export type JobIdAndTrigger<N extends JobEventName> =
  | {
      /** The job id. Also the triggering event name (1:1 convention). */
      id: N;
      trigger?: undefined;
    }
  | {
      /** A distinct function id — this job is an ADDITIONAL consumer of `trigger`. */
      id: string;
      /** The (already-consumed) event this function subscribes to. */
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
  /** Raw Inngest retry count (additional attempts after the first). Escape
   * hatch for an exact number; prefer `retryPolicy`. Mutually exclusive with it. */
  retries?: number;
  /**
   * Optional concurrency constraint(s) (MOTIR-1982). Three accepted forms, all
   * Inngest's own (`ConcurrencyOption` re-exported above):
   *
   *   - `number` — a bare limit on simultaneous runs of THIS function, across
   *     the whole environment. Every tenant shares one lane.
   *   - `ConcurrencyOption` — `{ limit, key?, scope? }`. `key` is a CEL
   *     expression over the triggering event (`event.data.workspaceId`), and
   *     Inngest creates a SUB-QUEUE per distinct key value.
   *   - `ConcurrencyOption[]` — several constraints at once, ALL of which must
   *     admit a run. This is how a job expresses fairness AND capacity:
   *
   *     ```ts
   *     concurrency: [
   *       { limit: 1, key: 'event.data.workspaceId' }, // no tenant monopolizes
   *       { limit: 4 },                                // total capacity
   *     ]
   *     ```
   *
   * The keyed form's fairness behaviour was MEASURED, not assumed — see the
   * "Concurrency" section of `docs/jobs.md` for the numbers, the harness that
   * produced them (`scripts/experiments/inngest-concurrency-fairness.mjs`),
   * and the one thing still unproven (the same run against Inngest Cloud).
   */
  concurrency?: number | ConcurrencyOption | ConcurrencyOption[];
  /**
   * Optional idempotency key template, evaluated against the event payload
   * (e.g. `"event.data.idempotencyKey"`). Forwarded to Inngest, which dedups
   * same-key events inside its window.
   */
  idempotency?: string;
  /**
   * Optional debounce (MOTIR-893) — forwarded to Inngest, which delays the run
   * until `period` has passed with no further same-`key` event, then runs ONCE
   * with the LATEST event (rapid same-key events coalesce). `key` is an event
   * expression (e.g. `"event.data.installationId"`); `timeout` optionally caps
   * the total delay so a steady event stream can't defer the run forever.
   *
   * ⚠️ TWO THINGS THE OPTION DOES NOT GUARANTEE, both measured against the real
   * scheduler rather than read off the docs (MOTIR-2994; the table, the harness
   * and the Cloud caveat are in the "Debounce" section of `docs/jobs.md`):
   *
   *   1. **`key` MUST name fields the event payload type makes REQUIRED.** It is
   *      a CEL string, so nothing type-checks it — and an expression that does
   *      not resolve does NOT disable the debounce, it MERGES: every such event
   *      lands in ONE bucket, so N unrelated events produce one run and N−1 are
   *      lost silently. `'event.data.parentId'` on an event whose item may be a
   *      root is the shape that bit MOTIR-2902.
   *   2. **`timeout` is not a latency guarantee.** On the dev server a stream
   *      arriving faster than ~1 event/second defeats it entirely — the run
   *      lands only once the stream stops. Fine for a human-paced producer,
   *      wrong for a machine-generated one.
   *
   * A job that grows a `debounce` belongs in `tests/jobs/debounce-burst.test.ts`,
   * which drives the pinned `inngest-cli` and counts the runs a burst produces.
   * Asserting the option off `fn.opts` proves only that it was forwarded.
   *
   * ⚠️ AND THE ENGINE NOW IMPLEMENTS IT (MOTIR-3483), so the option is no longer
   * "forwarded to Inngest" alone. It is validated HERE at registration — the
   * expression and both durations — and applied at ENQUEUE by
   * `lib/jobs/engine/dispatcher.ts`. Two consequences for a job author:
   *
   *   1. Limit (1) above is REVERSED on the engine's lane. An expression the
   *      engine cannot evaluate throws at module evaluation instead of merging,
   *      and a field the payload does not carry means "no coalescing for this
   *      event" instead of "one shared bucket". The rule about naming only
   *      REQUIRED fields still stands — it is what keeps the two lanes agreeing
   *      about which events are one repo's.
   *   2. Limit (2) is FIXED on the engine's lane: the deferral cap is measured
   *      from the first arrival and is honoured whatever the arrival rate.
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
       * event-triggered: Inngest invokes it on the cron, and the wrapper records
       * the ledger row's `event_name` as `scheduled.{id}` so the dashboard treats
       * scheduled + event-triggered runs uniformly.
       */
      cron: string;
      /**
       * What the Postgres engine's scheduler owes this job for a fire the worker
       * was down across — `all` / `latest` / `skip` (`lib/jobs/catchUp.ts`).
       * REQUIRED here and nowhere else: declaring it beside the cron is what
       * makes the policy complete BY CONSTRUCTION, the same property
       * `registerSchedule` and `registerEngineJob` already depend on.
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
 * ⚠️ THE LEDGER'S CORRELATION KEY — the whole of Bug MOTIR-3683 is in this
 * function, so read it before changing either call site.
 *
 * `recordTerminalFailure` correlates a failure back to its `running` row by
 * `(functionId, eventId)`. The run handler and `onFailure` are SEPARATE Inngest
 * invocations that each derive that key themselves, so the two derivations must
 * agree — and for a CRON job they did not.
 *
 * WHAT THE PRODUCTION LEDGER SHOWED (measured 2026-08-27, `system.daily-health-
 * check` among four jobs): 29 rows stranded at `running`, the oldest for 25 days,
 * each paired ~36 s later with a `failed` row for the same function whose
 * `event_id` was the **EMPTY STRING** — matching neither the engine's cuid nor
 * Inngest's ULID, so invisible to every lane audit this migration is verified
 * with. One logical run, two rows, neither true on its own.
 *
 * TWO THINGS WERE WRONG, and fixing only the second would not have been enough:
 *
 *  1. **A cron's failure payload carries NO event id.** Inngest nests the
 *     original event under `event.data.event`, and for a scheduled trigger its
 *     `id` arrives as `''`. The run handler meanwhile had a real id to use
 *     (`event.id`, a ULID). So the two sides were keyed on different things by
 *     construction — no fallback can reconcile them, because the value one side
 *     has simply does not reach the other.
 *
 *     **Hence `runId` for a cron, on BOTH sides.** `ctx.runId` in the handler and
 *     `event.data.run_id` in `onFailure` are the same run's id, which is the only
 *     identifier both invocations demonstrably hold. It costs nothing: a
 *     scheduled run has no meaningful triggering event anyway — which is why
 *     `eventName` is already the synthesized `scheduled.{id}` rather than a real
 *     event name.
 *
 *  2. **`??` treats `''` as present.** Even on the event-triggered path, where
 *     `original.id` IS populated (931 correlated `failed` rows say so), a nullish
 *     fallback answers a narrower question than the caller is asking: not "is
 *     this field set" but "is there an id here at all". An empty id is not an id.
 *     `||` is the honest test, and it is what keeps a `''` from ever again
 *     becoming a key that matches nothing.
 */
function ledgerCorrelationId(
  isScheduled: boolean,
  eventId: string | undefined | null,
  runId: string,
): string {
  if (isScheduled) return runId;
  return eventId || runId;
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
  const { id, concurrency, idempotency, debounce, cron, catchUp } = options;
  // Publish the schedule so `jobScheduleHealthService` can check that this cron
  // is still actually firing in production (MOTIR-1970). Registering HERE, at
  // the single choke point every job passes through, is what keeps the schedule
  // table complete by construction — a cron job cannot exist without appearing
  // in it.
  if (cron !== undefined) registerSchedule(id, cron);
  // The event this function subscribes to: the id itself (1:1 convention) or
  // the explicit `trigger` of an additional consumer.
  const triggerEvent = options.trigger ?? id;
  // Resolve the retry budget once (throws if both retryPolicy and retries are
  // given). Used BOTH for Inngest's config and for the final-attempt check below.
  const maxRetries = resolveRetries(options);

  // ── the Postgres engine's half of the SAME registration (MOTIR-3421) ───────
  // `lib/jobs/registry.ts` holds the built Inngest function objects the serve
  // route mounts; the Postgres engine cannot use one of those — it needs the raw
  // handler and the options it was declared with. Registering here, at the one
  // choke point every job passes through, is what keeps the engine's list
  // complete BY CONSTRUCTION rather than by anyone remembering to update it: a
  // job cannot be defined without appearing in both. Same argument, and same
  // shape, as `registerSchedule` directly above.
  //
  // ⚠️ PURELY ADDITIVE. It builds no Inngest object, changes no config, and runs
  // for every job whether or not the cutover switch (MOTIR-3423) routes that job
  // to the new engine. Until it does, this table is written and never read.
  const engineTrigger = cron !== undefined ? undefined : triggerEvent;
  // `maxRetries` is Inngest's count of ADDITIONAL attempts; the engine counts
  // TOTAL attempts, which is what `job_queue.max_attempts` stores and what
  // `lib/jobs/retries.ts` states its policies in. +1 is that translation, in the
  // one place it happens.
  const maxAttempts = maxRetries + 1;

  // ⚠️ VALIDATE THE TEMPLATE HERE, as the definition module is evaluated, so a
  // job the engine cannot dedupe fails loudly at load rather than silently
  // stopping deduplication at dispatch (MOTIR-3459).
  if (idempotency !== undefined) parseIdempotencyTemplate(id, idempotency);
  // ⚠️ AND THE DEBOUNCE, for the same reason and at the same moment (MOTIR-3483)
  // — the key expression AND both durations. A `period` the engine cannot parse
  // would otherwise surface at DISPATCH, i.e. on a request path, as an event that
  // failed to enqueue.
  if (debounce !== undefined) parseDebounce(id, debounce);

  registerEngineJob({
    id,
    trigger: engineTrigger,
    cron,
    maxAttempts,
    retryPolicy: options.retryPolicy,
    idempotency,
    // The catch-up disposition, beside the `cron` it qualifies (MOTIR-3470). It
    // rides the ENGINE registration and NOT the Inngest `config` object below —
    // it is an engine-side fact about a scheduler Inngest does not have, exactly
    // as the `maxAttempts` translation directly above is. Forwarding it would put
    // an unknown key in a function's synced config for no reader.
    catchUp,
    debounce,
    handler,
  });

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

  // Terminal-failure handler (1.6.6). Inngest invokes `onFailure` ONCE, after a
  // function permanently exhausts its retry budget — a SEPARATE invocation from
  // the failed run, triggered by the internal `inngest/function.failed` event.
  // This is where the dead-letter write lives now: a `step.run` scheduled from a
  // try/catch in the main handler AFTER the step that terminally failed is never
  // executed by the real Inngest executor (it finalizes the run as failed
  // first), so the 1.6.4 approach silently never wrote the failed/DLQ rows in
  // production — only the in-process unit harness, which ran the catch
  // synchronously, made it look like it worked. See PRODECT_FINDINGS #39.
  //
  // The failure event carries the ORIGINAL triggering event under
  // `event.data.event`; jobRunsService correlates it back to the `running` row
  // by (functionId, eventId) — the same eventId the main handler recorded.
  const onFailure = async (args: FailureHandlerArgs) => {
    const original = args.event.data.event;
    const payload = (original.data ?? {}) as { workspaceId?: string | null };
    const eventName = cron !== undefined ? `scheduled.${id}` : (original.name ?? triggerEvent);
    // The SAME derivation the run handler makes, which is the entire correlation
    // contract — see `ledgerCorrelationId`. On a cron both sides key on the run
    // id, because the failure payload's nested event carries no id at all.
    const eventId = ledgerCorrelationId(cron !== undefined, original.id, args.event.data.run_id);
    // ⚠️ OUTSIDE the `step.run`, and for the reason this whole hook exists
    // (MOTIR-3606). A step is memoized and re-scheduled by the executor; the
    // alert is a synchronous, best-effort notification that must fire on the one
    // pass through this handler, not be replayed or deferred. It cannot throw,
    // so it cannot cost the dead-letter write its own turn.
    alertTerminalJobFailure({
      functionId: id,
      eventName,
      workspaceId: payload.workspaceId ?? null,
      attempts: maxRetries + 1,
      engine: 'inngest',
      error: args.error,
    });
    await args.step.run('job-run:dead-letter', () =>
      jobRunsService.recordTerminalFailure({
        functionId: id,
        eventId,
        lane: 'inngest',
        eventName,
        workspaceId: payload.workspaceId ?? null,
        failure: serializeFailure(args.error),
        eventData: (original.data ?? {}) as Prisma.InputJsonValue,
        // Total attempts including the first = the Inngest retry budget + 1.
        attempts: maxRetries + 1,
      }),
    );
  };

  // The trigger is `triggerEvent` (the id under the 1:1 convention, or the
  // explicit `trigger` of an additional consumer); a cron job uses a `{ cron }`
  // trigger instead. 2-arg createFunction form: triggers live
  // in the options object, NOT a third argument (the legacy 3-arg form throws at
  // import in inngest@4.5 — finding #30 sharp edge #1). The cast pins
  // `retries: number` into Inngest's 0..20 literal union; our public API stays a
  // friendly `number` and the type-safety we care about (the `id` ∈
  // JobEventName) is enforced at the DefineJobOptions boundary above.
  const config = {
    id,
    retries: maxRetries,
    triggers: cron !== undefined ? [{ cron }] : [{ event: triggerEvent }],
    onFailure,
    // Concurrency is forwarded to Inngest essentially VERBATIM (MOTIR-1982).
    // Until then this read `{ concurrency: { limit: concurrency } }` off a
    // `concurrency?: number` option, which silently discarded `key` and
    // `scope` — the two fields that make a limit per-TENANT rather than one
    // global lane every workspace queues in. No job on the substrate could
    // express fairness, because the wrapper threw the expressiveness away at
    // the boundary, not because Inngest lacked it.
    //
    // The ONE thing not passed through untouched is the bare `number`, which
    // is still normalized to `{ limit: n }`. That is deliberate: it is exactly
    // the object today's call sites already produce, so widening the option
    // cannot change what an existing job syncs (Inngest's own schema coerces
    // the two to the same config, but "identical bytes" is a cheaper thing to
    // guarantee than "equivalent after coercion"). Object and array forms —
    // the new expressiveness — are forwarded with no massaging at all.
    ...(concurrency !== undefined
      ? { concurrency: typeof concurrency === 'number' ? { limit: concurrency } : concurrency }
      : {}),
    ...(idempotency !== undefined ? { idempotency } : {}),
    ...(debounce !== undefined ? { debounce } : {}),
  } as Parameters<typeof inngest.createFunction>[0];

  return inngest.createFunction(config, async (ctx: JobContext) => {
    // ── THE CUTOVER SWITCH, half two (MOTIR-3423) ──────────────────────────
    // The OTHER half is in `sendEvent`, which decides where to ENQUEUE. This one
    // decides whether to EXECUTE, and it is what makes "runs there and does NOT
    // also run on Inngest" true rather than hoped for.
    //
    // ⚠️ THE INNGEST FUNCTION IS STILL REGISTERED FOR A MIGRATED JOB, and that
    // is why this guard is necessary. The serve route mounts every function in
    // `lib/jobs/registry.ts`, so Inngest keeps delivering to a job whose id has
    // moved — an event with a SPLIT subscriber set still reaches Inngest for the
    // sake of the subscribers that have not moved, and Inngest fans out to ALL
    // of its registered consumers of that event, including the migrated one.
    // Without this early return the migrated job would run on BOTH engines.
    //
    // Un-registering the function instead would work and is worse: it is a
    // deploy-time change, so moving one job back would need a deploy rather than
    // an environment variable, and the switch would stop being reversible in the
    // one-line way the whole migration is built on.
    //
    // It returns a MARKER rather than `undefined` so an operator reading the
    // Inngest dashboard sees why a run did nothing — a silent no-op there is
    // indistinguishable from a job that broke.
    if (routedToEngine(id)) {
      return { skipped: 'routed-to-postgres-engine' as const, jobId: id };
    }

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
    // The triggering event's id correlates the run to its event; a SCHEDULED run
    // keys on the run id instead, on both sides — see `ledgerCorrelationId`.
    const eventId = ledgerCorrelationId(cron !== undefined, event.id, ctx.runId);

    const jobRun = await step.run('job-run:start', () =>
      jobRunsService.recordStart({
        workspaceId,
        functionId: id,
        eventName,
        eventId,
        // This wrapper IS the Inngest lane — the engine writes its own rows from
        // `lib/jobs/engine/ledger.ts`. Declared, never inferred (MOTIR-3683).
        lane: 'inngest',
        attempt: ctx.attempt,
        idempotencyKey,
      }),
    );

    // Success path only. On a thrown error we DON'T bookkeep here — the error
    // propagates so Inngest's retry machinery sees it; once the budget is spent
    // Inngest fires the function's `onFailure` (above), which writes the
    // `failed` + dead-letter rows. Bookkeeping the failure from a catch here
    // would not survive the real executor (PRODECT_FINDINGS #39). Non-final
    // attempts therefore leave the row `running` — the dashboard shows a
    // retrying run as in-flight, which is the intended UX.
    const result = await handler(ctx, jobServices);
    // `recordStart` returns null when the run's tenant vanished before the row
    // could be written (MOTIR-1545) — there is no ledger row to flip, so skip
    // the success bookkeeping rather than dereference a null id.
    if (jobRun) {
      // Persist the handler's resolved value on the ledger row when it survives a
      // JSON round-trip (5.2.7) — Inngest serializes step/run results the same
      // way, so anything it can return is storable; a non-serializable value
      // (cycles, BigInt) degrades to a NULL output, never a failed run.
      await step.run('job-run:succeeded', () =>
        jobRunsService.recordSuccess(jobRun.id, serializeOutput(result)),
      );
    }
    return result;
  });
}

/** JSON-roundtrip a handler result for the ledger's `output` column; undefined when not JSON-safe. */
function serializeOutput(result: unknown): Prisma.InputJsonValue | undefined {
  if (result === undefined || result === null) return undefined;
  try {
    return JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}
