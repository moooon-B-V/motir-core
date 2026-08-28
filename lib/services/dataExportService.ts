import 'server-only';

import { type DataExportRequest } from '@/generated/prisma/client';
import { deleteAttachmentBlob, putPrivateAttachment } from '@/lib/blob/uploader';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { dataExportRequestRepository } from '@/lib/repositories/dataExportRequestRepository';
import { dataExportExpiresAt } from '@/lib/users/dataSubjectRequests';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { archiveFilename, buildPersonalDataArchive } from '@/lib/export/personalDataArchive';

// THE PERSONAL-DATA EXPORT (Story 8.4 · Subtask MOTIR-3701 · design of record
// `design/settings/design-notes.md` → `Data & privacy`, DECISIONs 1 and 2).
//
// This service owns the request → build → expiry lifecycle. What goes IN the
// archive is `lib/export/personalDataSections.ts` (the enumeration) and
// `personalDataArchive.ts` (the packaging); this file owns the ROW.
//
// THE BUILD RUNS OUTSIDE ANY REQUEST TRANSACTION, and its failure marks the row
// `failed` rather than throwing into the caller. That is not defensive coding:
// the caller is a background job, and a build that throws would be retried by
// Inngest with no `failureReason` ever reaching the pane — the reader would
// watch a spinner that never resolves instead of seeing the failed state
// DECISION 2 routes to `privacy@motir.co`.

/** Content type of the built archive. */
const ARCHIVE_CONTENT_TYPE = 'application/zip';

/** Where a built archive lands in the private bucket. */
function archivePathname(userId: string, requestId: string, builtAt: Date): string {
  return `exports/${userId}/${requestId}/${archiveFilename(builtAt)}`;
}

export interface RequestDataExportResult {
  request: DataExportRequest;
  /** False when an open request already existed and was returned instead. */
  started: boolean;
}

export const dataExportService = {
  /**
   * Open an export request and kick off its build.
   *
   * ONE OPEN REQUEST PER USER. A second call while one is `preparing` returns
   * the existing row and starts NO second build — two archives of the same data
   * is waste, not corruption, which is why the model carries no unique index and
   * why this is a service-side check rather than a constraint (the repository's
   * own comment records that decision). The `FOR UPDATE` read is what makes the
   * check hold under concurrency for every case the lock can see; the repository
   * documents the one it cannot (two callers racing a user's very FIRST request
   * lock nothing, and both insert — a duplicate archive, and the pane shows the
   * newest).
   *
   * The event is emitted AFTER the transaction commits — the post-commit
   * contract every `sendEvent` call site keeps. An event emitted inside the
   * transaction can be delivered to a worker that then reads a row the rollback
   * removed.
   */
  async requestDataExport(userId: string): Promise<RequestDataExportResult> {
    const outcome = await withUserContext(userId, async (tx) => {
      const latest = await dataExportRequestRepository.findLatestByUserIdForUpdate(userId, tx);
      if (latest?.status === 'preparing') {
        const existing = await dataExportRequestRepository.findLatestByUserId(userId, tx);
        return { request: existing!, started: false };
      }
      const created = await dataExportRequestRepository.create(
        { userId, requestedAt: new Date() },
        tx,
      );
      return { request: created, started: true };
    });

    if (outcome.started) {
      await sendEvent('account/data-export.requested', {
        // An export is identity-scoped and spans every workspace the person
        // belongs to, so it has no single workspace — the `email.send` carve-out
        // shape, and `null` is the value the job_run row stores.
        workspaceId: null,
        userId,
        requestId: outcome.request.id,
      });
    }
    return outcome;
  },

  /**
   * Build the archive for one request and record the outcome.
   *
   * Reads the user's data under the USER's own context (the archive builder's
   * doing — see its scope note), and writes the outcome under the SYSTEM
   * context: the job has no session, and `data_export_request`'s policy carries
   * an `app.system_admin` arm for exactly this writer.
   *
   * Returns the summary the job persists on its ledger row.
   */
  async buildDataExport(input: { userId: string; requestId: string }) {
    const { userId, requestId } = input;

    try {
      const builtAt = new Date();
      const archive = await buildPersonalDataArchive(userId, builtAt);
      const pathname = archivePathname(userId, requestId, builtAt);
      // PRIVATE, never a public asset: the bytes are reachable only through the
      // authenticated download route, which mints a 300 s presigned URL per
      // click (DECISION 2). A public object would make the whole archive
      // world-readable to anyone who learned its URL.
      const put = await putPrivateAttachment(pathname, archive.bytes, ARCHIVE_CONTENT_TYPE);

      await withSystemContext((tx) =>
        dataExportRequestRepository.update(
          requestId,
          {
            status: 'ready',
            blobPathname: put.pathname,
            builtAt,
            // From the named constant, measured from the BUILD — an export that
            // took an hour is still downloadable for the full window after it
            // exists.
            expiresAt: dataExportExpiresAt(builtAt),
            failureReason: null,
          },
          tx,
        ),
      );

      return {
        requestId,
        status: 'ready' as const,
        bytes: archive.bytes.byteLength,
        counts: archive.counts,
        files: archive.files,
      };
    } catch (err) {
      const failureReason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await withSystemContext((tx) =>
        dataExportRequestRepository.update(
          requestId,
          { status: 'failed', failureReason: failureReason.slice(0, 1000) },
          tx,
        ),
      );
      // Swallowed BY DESIGN — see the header. The row is the durable record of
      // the failure, the pane reads it, and re-throwing would buy a retry of a
      // build that is very unlikely to succeed on a second attempt while
      // costing the reader a state they can act on.
      return { requestId, status: 'failed' as const, failureReason };
    }
  },

  /**
   * Expire every archive past its retention window: delete the blob, then mark
   * the row `expired` and clear its pathname.
   *
   * BLOB FIRST, ROW SECOND — the `attachmentGc` ordering, for its reason: a
   * failed blob delete leaves a row still pointing at the object, so the next
   * run finds it again. The inverse strands a private object nothing references,
   * which is exactly the data the seven-day promise says is gone.
   *
   * Cross-tenant by design (exports span every user), so it runs under
   * `withSystemContext` — the `data_export_request` policy's system arm.
   */
  async sweepExpiredDataExports(
    options: { batchSize?: number; now?: Date } = {},
  ): Promise<{ scanned: number; expired: number; failed: number }> {
    const { batchSize = 100, now = new Date() } = options;
    const summary = { scanned: 0, expired: 0, failed: 0 };

    const rows = await withSystemContext((tx) =>
      dataExportRequestRepository.listExpirable({ now, take: batchSize }, tx),
    );

    for (const row of rows) {
      summary.scanned += 1;
      if (row.blobPathname) {
        try {
          await deleteAttachmentBlob(row.blobPathname);
        } catch {
          // The row keeps its pathname and its `ready` status, so the next run
          // picks it up again. Never mark it expired on a failed delete: that
          // would say "the file is gone" about a file that is still there.
          summary.failed += 1;
          continue;
        }
      }
      await withSystemContext((tx) =>
        dataExportRequestRepository.update(
          row.id,
          // The pathname is cleared with the status: the model's own comment
          // makes a non-null value mean "there is a file to serve", so leaving
          // it set would have the download route offer a deleted object.
          { status: 'expired', blobPathname: null },
          tx,
        ),
      );
      summary.expired += 1;
    }

    return summary;
  },
};
