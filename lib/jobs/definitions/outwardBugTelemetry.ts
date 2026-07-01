import { defineJob } from '../defineJob';
import type { WorkItemCreatedData } from '../types';

// The OUTWARD self-improving loop's INPUT trigger (Story 7.6 · MOTIR-1481) — an
// ADDITIONAL consumer of the SHIPPED Story-1.6 `work-item/created` event (the
// same single-event / many-consumers fan-in the 5.7.3 notification job and the
// 6.6.2 automation engine already ride), so the loop fires no matter HOW a bug
// was filed (UI / MCP / API / the service-auth route). It hands every created
// item to `aiBugTelemetryService`, which filters to a user-project `kind: bug`
// and dispatches ONE `analyze_bug` job to motir-ai (classify → file → capture,
// MOTIR-967). This trigger performs NO classification.
//
// `work-item/created` is already consumed (by `automation-engine/created`), so
// this is the additional-consumer form: a DISTINCT id + an explicit `trigger`.
//
// `retryPolicy: 'idempotent'` (5 attempts): the dispatch is a post-commit side
// effect fully DECOUPLED from the originating create — it runs in its own
// Inngest function AFTER the create tx committed and the event fired, so a
// dispatch failure is retried and can NEVER fail or block the create. A
// transient motir-ai outage is worth the full retry budget; a permanent
// mis-config is short-circuited inside the service (no dispatch, no throw).

export const outwardBugTelemetryOnCreated = defineJob(
  {
    id: 'outward-bug-telemetry/created',
    trigger: 'work-item/created',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCreatedData;
    return ctx.step.run('dispatch-outward-analysis', () =>
      services.aiBugTelemetry.dispatchOutwardAnalysis({
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        workItemId: payload.workItemId,
        actorId: payload.actorId,
      }),
    );
  },
);
