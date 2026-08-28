import { defineJob } from '../defineJob';

// The personal-data export BUILD (Story 8.4 · Subtask MOTIR-3701 · design
// DECISION 1). Event-triggered: `dataExportService.requestDataExport` emits
// `account/data-export.requested` after its transaction commits, and this job
// assembles the archive, uploads it privately and records the outcome.
//
// `retryPolicy: 'none'` — ONE attempt, and this is the deliberate choice rather
// than the default. The handler does not throw: `buildDataExport` catches its
// own failure and marks the row `failed` with a reason, because a reader
// watching the pane needs a state they can act on (DECISION 2's
// `privacy@motir.co` route) more than they need a silent second attempt. A
// retry budget on a handler that never throws is budget that can never be
// spent, and declaring `transient` would say something untrue about how this
// job fails. If a transient class is ever worth retrying, the change is to
// re-throw it from the service — not to widen a policy here.
//
// ⚠️ IT DECLARED `concurrency: { limit: 1, key: 'event.data.userId' }` AND THAT
// OPTION NO LONGER EXISTS (MOTIR-3418, which retired the substrate that
// implemented it). The intent it recorded was "one build per user at a time —
// an archive is a whole-account read, so two of them for one person running at
// once is the one shape worth serialising."
//
// **The serialisation it wanted is still there, and it was always the stronger
// half.** `dataExportService.requestDataExport` takes
// `findLatestByUserIdForUpdate` and returns the EXISTING request without
// emitting when one is already `preparing` — so at most one build event per user
// is ever in flight, enforced by a row lock rather than by a scheduler's
// admission. The option was belt to that braces.
//
// **What is genuinely lost is the belt, and the decision not to rebuild it is
// recorded: `docs/decisions/job-queue-foundation.md` §14 (MOTIR-3731).** The
// Postgres engine has no per-job concurrency at all — it claims `CLAIM_BATCH`
// due runs per tick with `FOR UPDATE SKIP LOCKED` and reads no per-job limit —
// and §14 decides it will not grow one, because a claim-time admission decision
// carries a liveness obligation (`motir-ai`'s equivalent wedges a whole session
// on one abandoned `running` row) to buy a weaker guarantee than the row lock
// above already gives. Do NOT re-declare a `concurrency` here: `defineJob` does
// not accept one, and §14.3 is the table of what to reach for instead.
export const dataExportBuild = defineJob(
  {
    id: 'account/data-export.requested',
    retryPolicy: 'none',
  },
  async (ctx, services) => {
    const { userId, requestId } = ctx.event.data as { userId: string; requestId: string };
    return ctx.step.run('build-archive', () =>
      services.dataExport.buildDataExport({ userId, requestId }),
    );
  },
);
