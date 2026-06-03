import { withWorkspaceContext } from '@/lib/workspaces/context';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { putAttachment } from '@/lib/blob/uploader';
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
};
