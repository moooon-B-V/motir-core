import { defineJob } from '../defineJob';
import type { WorkItemCreatedData } from '../types';

// The bug ENRICHMENT trigger (Story MOTIR-4930 · Subtask MOTIR-5849) — an
// ADDITIONAL consumer of the shipped `work-item/created` event, the same fan-in
// `automation-engine/created` and `outward-bug-telemetry/created` ride. It hands
// every created item to `monitorBugEnrichmentService`, which filters to a bug the
// monitor reconciler filed and dispatches ONE `author_bug` job to motir-ai.
//
// ⚠️ THE TRIGGER IS A TRANSITION, AND ITS EFFECT REMOVES THE CONDITION. A job hung
// on a STATE ("a bug with a thin body") re-fires on every later observation of
// that state; creation happens once per item, and the dispatch writes
// `monitor_issue.authoringJobId`, which closes the eligibility question for good.
// So the story's "on a recurrence it re-authors nothing" is a property of the
// trigger rather than of a check: a recurrence against a LIVE bug creates no work
// item, and a RE-FILE after the bug was completed creates a new one, which is
// enriched.
//
// After the dispatch the same function WAITS — boundedly, on durable sleeps — for
// the job to finish, then writes its answer onto the bug (MOTIR-5851). Every way
// that can fail to happen is a value on the run's result, and the bug stays filed.
//
// `retryPolicy: 'idempotent'` (5 attempts): the dispatch runs in its own function
// AFTER the create committed, so a failure is retried and can never fail or block
// the filing. A transient motir-ai outage is worth the budget, and so is the
// ordering window in which the reconciler's link has not committed yet
// (`MonitorLinkNotYetVisibleError`). An exhausted budget dead-letters; the bug is
// unaffected either way.

/**
 * How many times the job re-reads a dispatched `author_bug` before it gives up,
 * and how long it sleeps between reads (MOTIR-5851). Together: a BOUNDED wait of
 * {@link MONITOR_AUTHORING_POLLS} × {@link MONITOR_AUTHORING_POLL_MS} — five
 * minutes, against a job that grounds and authors in well under one. The sleep is
 * the engine's durable `step.sleep`, so a waiting run holds no worker slot.
 * Exhausting the bound is a normal outcome (`timed-out`), never a retry into a
 * second model call — the dispatch key on the link row already says one was spent.
 */
export const MONITOR_AUTHORING_POLLS = 10;
export const MONITOR_AUTHORING_POLL_MS = 30_000;

export const monitorBugEnrichOnCreated = defineJob(
  {
    id: 'monitor-bug-enrich/created',
    trigger: 'work-item/created',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCreatedData;
    const trigger = {
      workspaceId: payload.workspaceId,
      projectId: payload.projectId,
      workItemId: payload.workItemId,
      actorId: payload.actorId,
      ...(payload.viaMonitorConnectionId
        ? { viaMonitorConnectionId: payload.viaMonitorConnectionId }
        : {}),
    };
    const dispatch = await ctx.step.run('dispatch-bug-authoring', () =>
      services.monitorBugEnrichment.dispatchEnrichment(trigger),
    );
    if (!dispatch.dispatched) return { dispatch };

    // AWAIT + APPLY (MOTIR-5851): a BOUNDED wait on the dispatched job, then the
    // write. Each sleep is the engine's durable yield, so a waiting run holds no
    // worker slot; each read is its own memoized step, so a resume after a deploy
    // never writes twice (and the write's own predicate would refuse it anyway).
    // The FIRST read is immediate — a job that finished while the dispatch step
    // was committing lands at once — and each later read follows a sleep.
    for (let poll = 0; poll < MONITOR_AUTHORING_POLLS; poll += 1) {
      if (poll > 0) await ctx.step.sleep(`await-bug-authoring-${poll}`, MONITOR_AUTHORING_POLL_MS);
      const applied = await ctx.step.run(`apply-authored-bug-${poll}`, () =>
        services.monitorBugEnrichment.applyAuthoredBug(trigger, dispatch.jobId),
      );
      if (applied.status !== 'pending') return { dispatch, applied };
    }
    // The job never finished inside the bound: the bug stays filed and unenriched.
    // Not retried into a second model call — the link row says one was spent.
    return { dispatch, applied: { status: 'skipped' as const, reason: 'timed-out' as const } };
  },
);
