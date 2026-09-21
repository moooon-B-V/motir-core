import { defineJob } from '../defineJob';
import type { MonitorEnrichmentBackfillData } from '../types';
import { MONITOR_AUTHORING_POLL_MS, MONITOR_AUTHORING_POLLS } from './monitorBugEnrich';

// The bug enrichment BACKFILL (Story MOTIR-5975 · Subtask MOTIR-5983) — the
// consumer of `monitor-issue/enrichment-backfill`, which the monitor poll's
// standing sweep emits for a bug the reconciler FILED that the enrichment never
// reached: filed before the enrichment shipped, when it only ever rode
// `work-item/created`.
//
// ⚠️ IT IS `monitorBugEnrichOnCreated`, TRIGGERED DIFFERENTLY, AND NOTHING ELSE.
// The same `dispatchEnrichment` then the same bounded `applyAuthoredBug` wait,
// the same retry policy, the same `MonitorLinkNotYetVisibleError` handling
// (thrown by the dispatch, retried by the policy). A second copy of the
// enrichment's rules would be a second place for them to drift; there is none.
//
// IDEMPOTENT TWICE OVER. The event's `idempotencyKey` is per LINK, so the
// engine's `(job_id, idempotency_key)` unique index lands ONE queue row however
// often the sweep emits it; and `dispatchEnrichment` reads the link's
// `authoringJobId` first and answers `already-dispatched`. A backfill that
// DEAD-LETTERS is re-driven by the DLQ replay (which suffixes the key), not by
// the next poll — the per-link key refuses a re-emit, which is the price of
// never submitting the same bug twice.

export const monitorBugEnrichBackfill = defineJob(
  {
    id: 'monitor-bug-enrich/backfill',
    trigger: 'monitor-issue/enrichment-backfill',
    retryPolicy: 'idempotent',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as MonitorEnrichmentBackfillData;
    const trigger = {
      workspaceId: payload.workspaceId,
      projectId: payload.projectId,
      workItemId: payload.workItemId,
      actorId: payload.actorId,
      viaMonitorConnectionId: payload.viaMonitorConnectionId,
    };
    const dispatch = await ctx.step.run('dispatch-bug-authoring', () =>
      services.monitorBugEnrichment.dispatchEnrichment(trigger),
    );
    if (!dispatch.dispatched) return { dispatch };

    for (let poll = 0; poll < MONITOR_AUTHORING_POLLS; poll += 1) {
      if (poll > 0) await ctx.step.sleep(`await-bug-authoring-${poll}`, MONITOR_AUTHORING_POLL_MS);
      const applied = await ctx.step.run(`apply-authored-bug-${poll}`, () =>
        services.monitorBugEnrichment.applyAuthoredBug(trigger, dispatch.jobId),
      );
      if (applied.status !== 'pending') return { dispatch, applied };
    }
    return { dispatch, applied: { status: 'skipped' as const, reason: 'timed-out' as const } };
  },
);
