// The project-logo upload policy (MOTIR-2677) — ONE constant pair, consumed by
// BOTH the server route that enforces it and the client control that states it.
//
// ⚠️ Why this file exists at all, rather than reusing `lib/blob/allowlist.ts`
// wholesale: the account Photo row tells people "PNG or JPG, up to 2 MB" in its
// copy and validates that on the CLIENT, while the server enforces only the
// shared `MAX_UPLOAD_BYTES` (10 MB) and `isImageType` (which also admits GIF,
// WebP and SVG). A crafted request therefore stores five times what the product
// promises, in a format the copy never offered. That gap is not copied here:
// the ceiling and the type set the design's copy table states are enforced
// SERVER-side, from these constants, and the client imports the same two values
// — so the number a person is told and the number that is true cannot drift.
//
// Kept dependency-free (no `lib/blob/s3`, no Prisma) so a `'use client'`
// component can import it without dragging the AWS SDK into its bundle — the
// same reason the retired preset registry stayed UI-free before it.

/**
 * The size ceiling for a project logo — **2 MB**, the figure
 * `design/projects/design-notes.md`'s copy table states verbatim ("PNG or JPG,
 * up to 2 MB"). Deliberately BELOW the shared `MAX_UPLOAD_BYTES` (10 MB): a logo
 * is a small square asset, and the promise in the copy is the one the server
 * keeps.
 */
export const PROJECT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The accepted MIME types — PNG and JPEG only, again matching the copy. A
 * narrower set than `ALLOWED_IMAGE_TYPES`, which admits GIF, WebP and **SVG**;
 * SVG is excluded here on purpose, because it can carry script and a logo is
 * rendered in chrome on every authenticated page. Nothing in the product needs
 * an animated or vector project logo, so the narrow set costs nothing.
 */
export const PROJECT_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg'];

/** The `accept` attribute for the file input, derived so it cannot disagree. */
export const PROJECT_IMAGE_ACCEPT = PROJECT_IMAGE_TYPES.join(',');

/** True when `mime` is a type a project logo may be stored as. */
export function isProjectImageType(mime: string): boolean {
  return PROJECT_IMAGE_TYPES.includes(mime);
}
