import { defineJob } from '../defineJob';

// Attachment orphan-GC (Story 5.2 · Subtask 5.2.7) — the storage-lifecycle
// backstop, scheduled on the 1.6 cron primitive like dailyHealthCheck. Sweeps
// `attachment` rows that have been UNLINKED (workItemId IS NULL) for longer
// than the 7-day safety window: cancelled create-modal uploads, embeds a body
// edit de-referenced (5.2.3), issue deletions (the 5.2.1 SetNull), and rows
// whose 5.2.2 post-commit blob delete failed. Per row: blob first, then row —
// a failed blob delete leaves the row for the next pass, never the inverse
// (which would strand the blob unfindably). The sweep is cursor-bounded
// (ORPHAN_GC_BATCH_SIZE × ORPHAN_GC_MAX_BATCHES_PER_RUN per run) and
// idempotent; the per-run { scanned, deleted, failed } summary is the
// handler's return value, persisted on the run's job_run ledger row.
//
// System-scoped: orphans span workspaces, so the sweep runs under
// withSystemContext (the RLS `app.system_admin` hatch from the 5.2.1
// migration); the ledger row is untenanted (workspace_id NULL), like every
// `system.*` job.
//
// `retryPolicy: 'idempotent'`: the sweep converges on re-run by construction
// (deleted rows stop matching `listOrphans`; the blob delete is idempotent on
// already-gone URLs), so a transient DB/Blob blip is worth Inngest's full
// 5-attempt budget — unlike the health check's point-in-time 'none'.
//
// KNOWN LIMITATION: blobs with NO attachment row at all (e.g. a
// workspace-cascade delete removed the rows) are out of this job's reach — a
// prefix-listing sweep against the blob store itself is the named Epic-8
// hardening extension (recorded in design/work-items/design-notes.md).

/** 03:30 every day — off-peak, clear of the 09:00 health check. */
export const ATTACHMENT_GC_CRON = '30 3 * * *';

export const attachmentGc = defineJob(
  { id: 'system.attachment-gc', cron: ATTACHMENT_GC_CRON, retryPolicy: 'idempotent' },
  async (ctx, services) => {
    return ctx.step.run('sweep-orphans', () => services.attachments.sweepOrphanAttachments());
  },
);
