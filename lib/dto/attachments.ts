// Wire DTOs for the attachment management surface (Story 5.2 · Subtask
// 5.2.2). The service maps Prisma rows to these via
// lib/mappers/attachmentMappers.ts just before returning (CLAUDE.md —
// services never return raw Prisma models). Dates are ISO strings, matching
// the work-items / comments DTO convention.

/** The uploader as the panel renders it (Avatar · name — the list view's "uploader" column). */
export interface AttachmentUploaderDTO {
  id: string;
  name: string;
  image: string | null;
}

/** One attachment card/row on the issue's panel (5.2.5). */
export interface AttachmentDTO {
  id: string;
  workItemId: string;
  /** The original filename (display name — the blob pathname carries a random suffix). */
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * How the file entered: `panel` (the Attach button / dropzone) or `editor`
   * (a description/comment embed). Editor-sourced rows render the source
   * indicator and their panel delete is BLOCKED (409) — remove the embed at
   * its source instead.
   */
  source: 'editor' | 'panel';
  /**
   * The AUTHENTICATED content path (`/api/attachments/<id>/content`, MOTIR-1667),
   * usable directly as `<img src>` / a download href — the route authorizes the
   * viewer and 302-redirects to a short-lived signed URL. NOT a raw/public blob
   * URL. (Field name retained for consumers; the value is the content path.)
   */
  blobUrl: string;
  /** True for image MIME types — the card thumbnails it and the 5.2.6 lightbox previews it. */
  isImage: boolean;
  /** True for PDFs — the other 5.2.6 previewable family; everything else downloads. */
  isPdf: boolean;
  uploader: AttachmentUploaderDTO;
  createdAt: string;
}

/**
 * One cursor-paged window of an issue's attachments, newest first (finding
 * #57 — never a load-all): up to ATTACHMENT_PAGE_SIZE rows. `totalCount` is
 * the panel's header count and the "Show more (N)" denominator; `nextCursor`
 * resumes after this page's last row, or null on the last page.
 */
export interface AttachmentsPageDTO {
  attachments: AttachmentDTO[];
  totalCount: number;
  nextCursor: string | null;
}
