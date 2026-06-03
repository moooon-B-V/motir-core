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

/** True when a MIME type embeds inline in Markdown (drives `![]` vs `[]`). */
export function isImageType(mime: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(mime);
}
