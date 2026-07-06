// The single source of truth for what a description / attachment upload accepts
// (Subtask 2.3.7, finding #52). One shared set so the create modal, the edit
// form, the upload endpoint, AND Epic 5's future attachments panel all enforce
// the same policy — and so the MarkdownEditor's paste/drop filter never diverges
// from what the server would accept.

/** Max upload size — 10 MB (card 2.3.7). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Images embed inline in Markdown (`![]`); kept as a subset so the editor can
 *  decide `![]` vs `[]` by MIME. SVG is included (it renders) but note it can
 *  carry script — Blob serves it as a static asset, not same-origin HTML. */
export const ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

/** Non-image files that upload + insert as a LINK (`[filename](url)`). */
export const ALLOWED_FILE_TYPES: readonly string[] = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/zip',
  // Common office docs.
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** The full allowlist (images + files). Anything not here is rejected (415). */
export const ALLOWED_UPLOAD_TYPES: readonly string[] = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_FILE_TYPES,
];

export function isAllowedUploadType(mime: string): boolean {
  return ALLOWED_UPLOAD_TYPES.includes(mime);
}

/**
 * Story-acceptance video MIME types (Story MOTIR-1627 · Subtask MOTIR-1629).
 * DELIBERATELY SEPARATE from {@link ALLOWED_UPLOAD_TYPES}: video is accepted
 * ONLY on the acceptance-upload path (the publish endpoint MOTIR-1631), never on
 * the generic editor / panel upload — a video pasted into a description or
 * dropped on the attachments panel is still rejected (415). `video/webm` is
 * Playwright's native recording output (primary); `video/mp4` is allowed for a
 * transcoded upload. Keeping this list out of the generic allowlist is what
 * makes the gate a hard, one-place policy rather than a per-call-site check.
 */
export const ALLOWED_ACCEPTANCE_VIDEO_TYPES: readonly string[] = ['video/webm', 'video/mp4'];

/** True when a MIME type is an allowed story-acceptance video (MOTIR-1629). */
export function isAllowedAcceptanceVideoType(mime: string): boolean {
  return ALLOWED_ACCEPTANCE_VIDEO_TYPES.includes(mime);
}

/** True when a MIME type embeds inline in Markdown (drives `![]` vs `[]`). */
export function isImageType(mime: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(mime);
}

/**
 * True for PDFs — with {@link isImageType} this drives the 5.2.6 preview
 * split (the Jira-verified contract: images + PDF open the lightbox, every
 * other type downloads). Carried on the AttachmentDTO so the panel never
 * re-derives the policy client-side.
 */
export function isPdfType(mime: string): boolean {
  return mime === 'application/pdf';
}
