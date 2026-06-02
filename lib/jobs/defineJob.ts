import { inngest } from './client';
import { jobServices, type JobServices } from './services';
import { jobRunsService } from '@/lib/services/jobRunsService';
import type { JobEventName } from './types';
import type { JobRunFailure } from '@/lib/dto/jobs';

// The canonical wrapper around `inngest.createFunction` (Story 1.6 · Subtask
// 1.6.2). Every background job is defined through this — never the raw SDK —
// so the run-ledger bookkeeping (the read path the 1.6.5 dashboard renders) is
// automatic and uniform.
//
// What the wrapper adds around the user handler:
//   1. writes a `running` job_run row at start (capturing workspaceId from the
//      event payload, attempt, event name/id);
//   2. on success → flips the row to `succeeded`;
//   3. on throw → flips the row to `failed` with the serialized error, THEN
//      re-throws so Inngest's retry machinery still sees the failure.
//
// The three bookkeeping writes run inside `step.run(...)`, which Inngest
// memoizes: they execute EXACTLY ONCE per run even though the handler body is
// re-invoked at every step boundary (durable-execution replay). That keeps the
// ledger one-row-per-run for multi-step jobs (1.6.3's email.send), not one row
// per replay.
//
// NOTE (deferred to 1.6.4): retry/idempotency/DLQ semantics. `attempt` is
// recorded from `ctx.attempt` at the run's FIRST execution (the start step is
// memoized, so a retried run keeps the original row's attempt value). The
// `idempotency` template is accepted and forwarded to Inngest here; the
// job_run-side dedup that reads `idempotency_key` lands with the DLQ work.

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
  /** Inngest retry count on failure. Default 3. */
  retries?: number;
  /** Optional concurrency limit (max simultaneous runs). */
  concurrency?: number;
  /**
   * Optional idempotency key template, evaluated against the event payload
   * (e.g. `"event.data.workspaceId + '-' + event.data.invoiceId"`). Forwarded
   * to Inngest; the ledger-side dedup is 1.6.4.
   */
  idempotency?: string;
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
  const { id, retries = 3, concurrency, idempotency } = options;

  // event name === id (the 1:1 convention). 2-arg createFunction form: triggers
  // live in the options object, NOT a third argument (the legacy 3-arg form
  // throws at import in inngest@4.5 — finding #30 sharp edge #1). The cast pins
  // `retries: number` into Inngest's 0..20 literal union; our public API stays
  // a friendly `number` and the type-safety we care about (the `id` ∈
  // JobEventName) is enforced at the DefineJobOptions boundary above.
  const config = {
    id,
    retries,
    triggers: [{ event: id }],
    ...(concurrency !== undefined ? { concurrency: { limit: concurrency } } : {}),
    ...(idempotency !== undefined ? { idempotency } : {}),
  } as Parameters<typeof inngest.createFunction>[0];

  return inngest.createFunction(config, async (ctx: JobContext) => {
    const { event, step } = ctx;
    const data = event.data as { workspaceId?: string | null; idempotencyKey?: string } | undefined;
    const workspaceId = data?.workspaceId ?? null;
    // Record the idempotency key the run executed under (when the event
    // carries one) so the operator dashboard (1.6.5) can show it. This only
    // POPULATES the column — the ledger-side dedup that READS it to skip a
    // duplicate run is 1.6.4; today's dedup is Inngest's own event-level
    // dedup, configured per-job via the `idempotency` option above.
    const idempotencyKey = data?.idempotencyKey ?? null;
    // The triggering event's id correlates the run to its event; fall back
    // to the runId when the event carries no id (e.g. the test harness's
    // synthetic event).
    const eventId = event.id ?? ctx.runId;

    const jobRun = await step.run('job-run:start', () =>
      jobRunsService.recordStart({
        workspaceId,
        functionId: id,
        eventName: event.name,
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
      await step.run('job-run:failed', () => jobRunsService.recordFailure(jobRun.id, failure));
      throw err;
    }
  });
}
