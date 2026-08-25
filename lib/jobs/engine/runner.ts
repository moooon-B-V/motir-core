import type { JobQueueRun } from '@/generated/prisma/client';
import { jobServices } from '../services';
import type { JobContext } from '../defineJob';
import { engineJob } from './registry';
import { createStepApi } from './step';

// The RUNNER (Story MOTIR-3414 · Subtask MOTIR-3421) — the bridge from a
// `job_queue` row to the handler a `defineJob` call declared.
//
// It is small, and the only interesting thing in it is the SHAPE OF THE CONTEXT
// it synthesizes.
//
// ===========================================================================
// Why there is exactly one cast in this file
// ===========================================================================
// `JobContext` is INFERRED FROM THE INNGEST SDK:
//
//   type JobContext = Parameters<Parameters<typeof inngest.createFunction>[1]>[0]
//
// (`lib/jobs/defineJob.ts`). It is a large structural type carrying fields no
// engine could supply without depending on Inngest's internals — which is
// precisely the coupling this epic exists to remove.
//
// Measured on `origin/main@165f1485`, handlers in this tree touch FOUR of its
// members and no others:
//
//   $ grep -rho 'ctx\.[a-zA-Z]*' lib/jobs/ --include='*.ts' | sort | uniq -c
//        63 ctx.step
//        28 ctx.event
//        11 ctx.runId
//         3 ctx.attempt
//
// So the engine builds those four and casts ONCE, here, at the boundary. The
// alternative — widening `JobContext` to a union of Inngest's type and ours —
// was rejected because it would change the type every handler is written
// against, and the whole point of MOTIR-3422's shim is that the 58 `step.run`
// call sites do not learn the engine changed.
//
// ⚠️ THE CAST IS A CLAIM, AND THE CLAIM IS TESTED. `tests/jobs/engine-runner.test.ts`
// asserts the four-member surface against the tree, so a handler that starts
// using a FIFTH member of `ctx` fails a test here rather than throwing
// `undefined is not a function` inside a background job in production — which is
// the failure mode a cast normally buys you and the reason this one is confined
// to a single line with a guard behind it.

/** The context members the engine supplies. Everything a handler in this tree actually reads. */
export interface EngineJobContext {
  event: { name: string; data: unknown; id?: string };
  step: ReturnType<typeof createStepApi>;
  runId: string;
  attempt: number;
}

/** Thrown when a claimed run names a job id nothing has registered. */
export class UnknownEngineJobError extends Error {
  readonly code = 'UNKNOWN_ENGINE_JOB' as const;
  constructor(jobId: string) {
    super(
      `job_queue row names job "${jobId}", which is not in the engine registry. ` +
        `Either its definition module was never imported (the registry is complete ` +
        `only for evaluated modules — see lib/jobs/engine/registry.ts) or the job ` +
        `was deleted while runs for it were still queued.`,
    );
    this.name = 'UnknownEngineJobError';
  }
}

/**
 * Build the context for one claimed run.
 *
 * `attempt` is ZERO-INDEXED, matching Inngest's `ctx.attempt` — the three
 * handlers that read it compare against a retry budget, so an off-by-one here
 * would change their behaviour silently. `job_queue.attempts` counts attempts
 * INCLUDING the current one (it is incremented at the claim), hence the −1.
 */
export function buildEngineContext(run: JobQueueRun, eventData: unknown): EngineJobContext {
  return {
    event: {
      name: run.eventName,
      data: eventData ?? {},
      ...(run.eventId ? { id: run.eventId } : {}),
    },
    step: createStepApi({ runId: run.id, workspaceId: run.workspaceId }),
    // The ENGINE's run id is the queue row id. Handlers use it to key
    // per-run state (`index-wait:<pid>:<n>` style ids are built from step ids,
    // not this), and it must be stable across a resume — which the row id is and
    // a per-process id would not be.
    runId: run.id,
    attempt: Math.max(0, run.attempts - 1),
  };
}

/**
 * Execute one claimed run: resolve its handler, synthesize the context, invoke.
 *
 * Throws whatever the handler throws — including `JobStepYield`, which the
 * worker distinguishes from a failure. The runner deliberately does NOT catch:
 * deciding what a throw MEANS is the worker's job, and swallowing it here would
 * make a failed run look successful.
 */
export async function runQueuedJob(run: JobQueueRun, eventData: unknown): Promise<unknown> {
  const def = engineJob(run.jobId);
  if (!def) throw new UnknownEngineJobError(run.jobId);
  const ctx = buildEngineContext(run, eventData);
  return def.handler(ctx as unknown as JobContext, jobServices);
}
