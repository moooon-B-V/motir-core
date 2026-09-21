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
// `retryPolicy: 'idempotent'` (5 attempts): the dispatch runs in its own function
// AFTER the create committed, so a failure is retried and can never fail or block
// the filing. A transient motir-ai outage is worth the budget, and so is the
// ordering window in which the reconciler's link has not committed yet
// (`MonitorLinkNotYetVisibleError`). An exhausted budget dead-letters; the bug is
// unaffected either way.

export const monitorBugEnrichOnCreated = defineJob(
  {
    id: 'monitor-bug-enrich/created',
    trigger: 'work-item/created',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCreatedData;
    return ctx.step.run('dispatch-bug-authoring', () =>
      services.monitorBugEnrichment.dispatchEnrichment({
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        workItemId: payload.workItemId,
        actorId: payload.actorId,
        ...(payload.viaMonitorConnectionId
          ? { viaMonitorConnectionId: payload.viaMonitorConnectionId }
          : {}),
      }),
    );
  },
);
