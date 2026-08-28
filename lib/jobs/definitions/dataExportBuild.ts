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
// **What is genuinely lost is the belt, and it is filed rather than papered
// over: MOTIR-3731.** The Postgres engine has no per-job concurrency at all — it
// claims `CLAIM_BATCH` due runs per tick with `FOR UPDATE SKIP LOCKED` and reads
// no per-job limit — so a `concurrency` on a definition would have been an
// accepted-and-ignored field, which is worse than an absent one. Do not
// re-declare it here; if a second, weaker guard is wanted, it is an engine
// feature against `job_queue`'s claim predicate.
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
