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
export const dataExportBuild = defineJob(
  {
    id: 'account/data-export.requested',
    retryPolicy: 'none',
    // One build per user at a time. The service's `FOR UPDATE` check already
    // refuses a second REQUEST while one is preparing; this is the other side
    // of it — an archive is a whole-account read, so two of them for one person
    // running at once is the one shape worth serialising.
    concurrency: { limit: 1, key: 'event.data.userId' },
  },
  async (ctx, services) => {
    const { userId, requestId } = ctx.event.data as { userId: string; requestId: string };
    return ctx.step.run('build-archive', () =>
      services.dataExport.buildDataExport({ userId, requestId }),
    );
  },
);
