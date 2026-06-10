import type { Attachment, Prisma } from '@prisma/client';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { deleteAttachmentBlob, putAttachment } from '@/lib/blob/uploader';
import { MAX_UPLOAD_BYTES, isAllowedUploadType, isImageType } from '@/lib/blob/allowlist';
import { FileTooLargeError, RateLimitError, UnsupportedFileTypeError } from '@/lib/blob/errors';

// Attachment upload (Subtask 2.3.7, finding #52). GENERAL — not image-only: the
// same primitive serves the description editor's inline-image case AND Epic 5's
// attachments panel. Server-proxied (the route hands us the File): the gates run
// here, in ONE place, before anything touches Blob, and the audit row is written
// transactionally in the same request — vs `@vercel/blob`'s client-direct
// `handleUpload`, whose `onUploadCompleted` callback doesn't fire on localhost /
// preview, which would make the attachment-row recording fragile (decision: the
// card's illustrative handleUpload loses to a testable, gate-centralised
// server-proxied `put` — justified, finding #52 follow-up).

export interface UploadContext {
  userId: string;
  workspaceId: string;
}

export interface UploadAttachmentResult {
  url: string;
  mime: string;
  /** Whether the file embeds inline (`![]`) vs inserts as a link (`[]`). */
  isImage: boolean;
}

/**
 * One linked/unlinked file in an `attachments` revision-diff cell. `name` is
 * what the 5.5.1 collection renderer displays; the ids keep the trail
 * queryable after the row (hard-delete, 5.2.2) or the link is gone.
 */
export interface AttachmentDiffItem {
  attachmentId: string;
  name: string;
  source: 'editor' | 'panel';
}

/**
 * The `{ attachments: ... }` diff-cell value (the 5.5.1 registry's
 * `collectionField` shape — registered there ahead of this merge). Ops are
 * present only when non-empty.
 */
export interface AttachmentsDiffCell {
  added?: AttachmentDiffItem[];
  removed?: AttachmentDiffItem[];
}

export interface SyncEditorLinksArgs {
  /**
   * The issue whose bodies were just written, in POST-write state (the
   * updated row / the unchanged row a comment write rides on). The bodies
   * feed the still-referenced-elsewhere guard, so they MUST reflect the
   * state the enclosing transaction is committing.
   */
  workItem: {
    id: string;
    workspaceId: string;
    descriptionMd: string | null;
    explanationMd: string | null;
  };
  /** Blob URLs the OLD version of the just-written body/bodies referenced. */
  previousUrls: readonly string[];
  /** Blob URLs the NEW version references ([] on a delete). */
  nextUrls: readonly string[];
}

/**
 * Orphan-GC tuning (Subtask 5.2.7). The safety window is how long an UNLINKED
 * row survives before the sweep may take it — long enough that an in-flight
 * create-modal upload / body edit never loses its file (admin-configurable is
 * Epic-8 territory; a constant here). Batch size bounds every `listOrphans`
 * read, and the per-run batch cap bounds the whole run (finding #57 applied to
 * storage): a huge backlog converges across daily runs instead of producing
 * one unbounded run.
 */
export const ORPHAN_SAFETY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const ORPHAN_GC_BATCH_SIZE = 200;
export const ORPHAN_GC_MAX_BATCHES_PER_RUN = 10;

/** One GC run's summary — persisted on the run's job_run ledger row. */
export interface OrphanSweepSummary {
  /** Orphan rows the run attempted (each at most once per run). */
  scanned: number;
  /** Rows whose blob AND row were removed. */
  deleted: number;
  /** Rows left in place because the blob delete failed — next run's work. */
  failed: number;
}

// Per-user rate limit — a simple in-memory sliding window. Per-instance only
// (fine pre-Epic-8; a shared limiter is an Epic-8 concern). ~10 uploads / minute.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const uploadLog = new Map<string, number[]>();

function checkRateLimit(userId: string): void {
  const now = Date.now();
  const recent = (uploadLog.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) throw new RateLimitError();
  recent.push(now);
  uploadLog.set(userId, recent);
}

export const attachmentsService = {
  async uploadAttachment(file: File, ctx: UploadContext): Promise<UploadAttachmentResult> {
    // Gates, cheapest first — reject BEFORE spending a Blob round-trip.
    if (file.size > MAX_UPLOAD_BYTES) throw new FileTooLargeError(MAX_UPLOAD_BYTES);
    if (!isAllowedUploadType(file.type)) throw new UnsupportedFileTypeError(file.type);
    checkRateLimit(ctx.userId);

    const pathname = `attachments/${ctx.workspaceId}/${file.name}`;
    const { url } = await putAttachment(pathname, file, file.type);

    // Audit row under the active-workspace RLS context.
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) =>
      attachmentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          uploaderUserId: ctx.userId,
          blobUrl: url,
          mimeType: file.type,
          sizeBytes: file.size,
          originalFilename: file.name,
        },
        tx,
      ),
    );

    return { url, mime: file.type, isImage: isImageType(file.type) };
  },

  /**
   * Link-on-write (Subtask 5.2.3) — the embeds-ARE-attachments rule. Editor
   * uploads write UNLINKED rows (a create-modal upload happens before the
   * issue exists), so linkage resolves at body-write time: the owning service
   * (workItemsService create/update; commentsService add/edit/delete) parses
   * the body's referenced blob URLs (lib/blob/referencedUrls.ts) and calls
   * this INSIDE its existing transaction (required `tx` — the
   * workItemRevisionsService.recordRevision contract).
   *
   * Semantics, per the Jira-verified Story 5.2 contract:
   *   - newly-referenced URLs LINK their rows (`source: 'editor'`) — but only
   *     rows that are currently UNLINKED: a row attached to another issue is
   *     never stolen by a pasted URL (the same file on two issues is two
   *     attachments in the mirror product), and a row already on this issue
   *     is a no-op.
   *   - de-referenced URLs UNLINK their rows (GC-eligible, 5.2.7) — but only
   *     EDITOR-sourced rows linked to THIS issue (panel-sourced rows are
   *     never touched by body diffs), and only when no other body on the
   *     issue still references the URL: the post-write description /
   *     explanation (passed in) and the comment bodies (a bounded existence
   *     probe per candidate URL, never a scan).
   *
   * Returns the `attachments` diff-cell for the caller's revision row (the
   * 5.5.1 collection shape), or null when nothing changed — re-saving an
   * unchanged body diffs to two empty sets and short-circuits without
   * touching the DB. The CALLER records the revision: an edit folds the cell
   * into its 'updated' diff, a comment write records a dedicated row, and
   * the create path deliberately records nothing (the links-at-create
   * precedent, 2.4.10 — attachments arriving with the issue are part of the
   * 'created' anchor, not a later edit).
   */
  async syncEditorLinks(
    args: SyncEditorLinksArgs,
    tx: Prisma.TransactionClient,
  ): Promise<AttachmentsDiffCell | null> {
    const prev = new Set(args.previousUrls);
    const next = new Set(args.nextUrls);
    const addedUrls = [...next].filter((url) => !prev.has(url));
    const removedUrls = [...prev].filter((url) => !next.has(url));
    if (addedUrls.length === 0 && removedUrls.length === 0) return null;

    const { workItem } = args;
    const toItem = (row: Attachment): AttachmentDiffItem => ({
      attachmentId: row.id,
      name: row.originalFilename,
      source: 'editor',
    });
    const cell: AttachmentsDiffCell = {};

    if (addedUrls.length > 0) {
      const rows = await attachmentRepository.findManyByBlobUrls(
        workItem.workspaceId,
        addedUrls,
        tx,
      );
      const linkable = rows.filter((row) => row.workItemId === null);
      if (linkable.length > 0) {
        await attachmentRepository.linkToWorkItem(
          linkable.map((row) => row.id),
          workItem.id,
          'editor',
          tx,
        );
        cell.added = linkable.map(toItem);
      }
    }

    if (removedUrls.length > 0) {
      const rows = await attachmentRepository.findManyByBlobUrls(
        workItem.workspaceId,
        removedUrls,
        tx,
      );
      const candidates = rows.filter(
        (row) => row.workItemId === workItem.id && row.source === 'editor',
      );
      const toUnlink: Attachment[] = [];
      for (const row of candidates) {
        const inIssueBodies =
          (workItem.descriptionMd?.includes(row.blobUrl) ?? false) ||
          (workItem.explanationMd?.includes(row.blobUrl) ?? false);
        if (inIssueBodies) continue;
        if (await commentRepository.someBodyReferences(workItem.id, row.blobUrl, tx)) continue;
        toUnlink.push(row);
      }
      if (toUnlink.length > 0) {
        await attachmentRepository.unlinkFromWorkItem(
          toUnlink.map((row) => row.id),
          tx,
        );
        cell.removed = toUnlink.map(toItem);
      }
    }

    return cell.added || cell.removed ? cell : null;
  },

  /**
   * The orphan-GC sweep (Subtask 5.2.7) — the storage-lifecycle backstop the
   * `system.attachment-gc` cron job runs. Unlinked rows accumulate by design:
   * create-modal uploads whose modal was cancelled, embeds de-referenced by a
   * body edit (5.2.3 unlinks), issue deletions (5.2.1 SetNull), and 5.2.2
   * panel deletes whose best-effort post-commit blob delete failed. Rows
   * unlinked for longer than ORPHAN_SAFETY_WINDOW_MS are removed, BLOB FIRST,
   * THEN ROW: if the blob delete fails the row survives and the next run
   * retries it; the inverse order would strand the blob with no row left to
   * find it by. Linked rows and orphans younger than the window are never
   * touched.
   *
   * Deliberately NOT one big transaction (the one-method-one-tx rule yields
   * here, like the 5.2.2 post-commit blob delete it backstops): each row's
   * delete is its own withSystemContext tx, so a network call to the blob
   * store never runs inside an open DB transaction and partial progress
   * persists — which is exactly what makes a re-run after a mid-sweep crash
   * idempotent (already-deleted rows simply no longer match `listOrphans`,
   * and `deleteAttachmentBlob` is idempotent on already-gone URLs).
   *
   * System context, not workspace context: orphans span every workspace (the
   * RLS `app.system_admin` hatch the 5.2.1 migration added for precisely this
   * caller).
   *
   * KNOWN LIMITATION (documented in the job header + design-notes): blobs
   * with NO attachment row at all — e.g. a workspace-cascade delete removed
   * the rows — are out of this sweep's reach; a prefix-listing sweep against
   * the blob store itself is the named Epic-8 hardening extension.
   */
  async sweepOrphanAttachments(
    // The tuning seam: the cron job runs the defaults; tests shrink them to
    // exercise the paging/cap branches without thousands of fixture rows.
    options: { batchSize?: number; maxBatchesPerRun?: number } = {},
  ): Promise<OrphanSweepSummary> {
    const { batchSize = ORPHAN_GC_BATCH_SIZE, maxBatchesPerRun = ORPHAN_GC_MAX_BATCHES_PER_RUN } =
      options;
    const olderThan = new Date(Date.now() - ORPHAN_SAFETY_WINDOW_MS);
    const summary: OrphanSweepSummary = { scanned: 0, deleted: 0, failed: 0 };
    // Rows attempted this run — a blob-delete failure leaves its row in the
    // table, so without this set a failing row would be re-fetched and
    // re-attempted every batch until the batch cap, instead of once per run.
    const attempted = new Set<string>();
    const blobFailed = new Set<string>();
    let cursor: string | undefined;

    for (let batch = 0; batch < maxBatchesPerRun; batch++) {
      const rows = await withSystemContext((tx) =>
        attachmentRepository.listOrphans({ olderThan, take: batchSize, cursor }, tx),
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        if (attempted.has(row.id)) continue;
        attempted.add(row.id);
        summary.scanned += 1;
        try {
          await deleteAttachmentBlob(row.blobUrl);
        } catch {
          // Blob first, row second: the surviving row IS the retry marker —
          // the next RUN picks it up again (the `attempted` set keeps this
          // run from hammering it batch after batch).
          blobFailed.add(row.id);
          summary.failed += 1;
          continue;
        }
        await withSystemContext((tx) => attachmentRepository.delete(row.id, tx));
        summary.deleted += 1;
      }

      // A short page means the backlog end was reached — done for this run.
      if (rows.length < batchSize) break;

      // Prisma cursor pagination needs the cursor row to still EXIST — a
      // deleted cursor row makes the next page come back empty. The page's
      // last row survives only when its blob delete failed (then it's a valid
      // anchor to continue past); otherwise restart from the front — the
      // deletes themselves advanced the window, and the `attempted` guard
      // skips any failed stragglers left there.
      const last = rows[rows.length - 1]!;
      cursor = blobFailed.has(last.id) ? last.id : undefined;
    }

    return summary;
  },
};
