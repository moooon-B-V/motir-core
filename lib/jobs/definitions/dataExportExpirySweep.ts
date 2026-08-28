import { defineJob } from '../defineJob';

// The personal-data export EXPIRY sweep (Story 8.4 · Subtask MOTIR-3701 ·
// design DECISION 2). A built archive is downloadable for
// `DATA_EXPORT_RETENTION_DAYS`; after that its blob is DELETED and the row
// moves to `expired`, which the pane renders as "request a new one".
//
// The seven days are a promise made to the reader on the pane, so the deletion
// is the promise being kept: a private object left behind after its row expired
// is exactly the data we said was gone.
//
// System-scoped: exports span every user, so the sweep runs under
// `withSystemContext` (the `data_export_request` policy's system arm) and its
// ledger row is untenanted, like every `system.*` job.
//
// `retryPolicy: 'idempotent'`: the sweep converges on re-run by construction —
// an expired row stops matching `listExpirable`, and S3's delete-object
// succeeds on an already-gone key — so a transient blip is worth the full retry
// budget (the `attachmentGc` precedent, for its reasons).

/** 05:30 every day. The nightly table-walk cascade already runs 03:30 → 05:00
 *  (attachment GC → rate-limit → automation retention → code-graph offboard);
 *  :30 is an already-clustered minute, so this adds no new wake on a compute
 *  that suspends when idle, and it takes the slot after the cascade rather than
 *  contending with it. */
export const DATA_EXPORT_EXPIRY_CRON = '30 5 * * *';

export const dataExportExpirySweep = defineJob(
  {
    id: 'system.data-export-expiry-sweep',
    cron: DATA_EXPORT_EXPIRY_CRON,
    // `latest`: a missed tick is worth running once when the worker returns —
    // the window is a promise with a date on it, so a sweep skipped entirely
    // would leave objects past their retention until the following night. There
    // is nothing to gain from replaying every missed tick: the sweep's read is
    // "everything past expiry now", so one run catches up on all of them.
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep-expired-exports', () =>
      services.dataExport.sweepExpiredDataExports(),
    );
  },
);
