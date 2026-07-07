import { del, issueSignedToken, presignUrl, put } from '@vercel/blob';

// The blob-storage adapter (Subtask 2.3.7; delete added in 5.2.7) — the ONE
// place that talks to Vercel Blob, so swapping to S3/GCS for an enterprise
// deployment is a single-file change (the card's stated reason for naming this
// seam). `put`/`del` read `BLOB_READ_WRITE_TOKEN` from the env automatically.
// Tests mock THIS module so nothing hits the network. `addRandomSuffix` keeps
// two same-named uploads from clobbering each other; `access: 'public'` because
// a Markdown `![]`/`[]` needs a directly-fetchable URL (the row is the
// audit/billing trail, not the gate).

export interface PutResult {
  url: string;
}

export async function putAttachment(
  pathname: string,
  body: File | Blob | ArrayBuffer | Buffer,
  contentType: string,
): Promise<PutResult> {
  const result = await put(pathname, body, {
    access: 'public',
    contentType,
    addRandomSuffix: true,
  });
  return { url: result.url };
}

/**
 * Delete one stored blob by its URL (Subtask 5.2.7; 5.2.2's panel delete is
 * the other caller). Vercel Blob's `del` is idempotent — deleting an
 * already-gone URL resolves fine — which is what makes the GC's
 * blob-before-row ordering safe to re-run after a partial failure.
 */
export async function deleteAttachmentBlob(url: string): Promise<void> {
  await del(url);
}

// ── Access-controlled attachments (MOTIR-1665) — the two-store split ──────────
// Avatars / public assets go to a dedicated PUBLIC store (a profile picture
// renders everywhere with no per-item auth context → a directly-fetchable URL).
// Content attachments (comment/description embeds, panel files, acceptance
// video/trace) go to the PRIVATE store and are served ONLY through the
// authenticated content route via `signedDownloadUrl`. The legacy `putAttachment`
// above is retained until its consumers migrate onto these two seams.

export interface PrivatePutResult {
  /** The blob key. A private blob has no world-readable URL; the content route
   *  mints a short-lived signed URL from this via `signedDownloadUrl`. */
  pathname: string;
}

/**
 * Upload a PUBLIC asset (avatars) to the dedicated public store
 * (`BLOB_PUBLIC_READ_WRITE_TOKEN`). Returns a directly-fetchable public URL —
 * public by design, since it is rendered without any per-item authorization.
 */
export async function putPublicAsset(
  pathname: string,
  body: File | Blob | ArrayBuffer | Buffer,
  contentType: string,
): Promise<PutResult> {
  const result = await put(pathname, body, {
    access: 'public',
    contentType,
    addRandomSuffix: true,
    token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
  });
  return { url: result.url };
}

/**
 * Upload a PRIVATE content attachment to the private store (default
 * `BLOB_READ_WRITE_TOKEN`). Returns the blob PATHNAME (the key), never a URL —
 * the bytes are reachable only through the authenticated content route.
 */
export async function putPrivateAttachment(
  pathname: string,
  body: File | Blob | ArrayBuffer | Buffer,
  contentType: string,
): Promise<PrivatePutResult> {
  const result = await put(pathname, body, {
    access: 'private',
    contentType,
    addRandomSuffix: true,
  });
  return { pathname: result.pathname };
}

/**
 * Mint a short-lived signed GET URL for a PRIVATE blob. Uses the `@vercel/blob`
 * 2.4.0 delegation flow — `issueSignedToken` (a `get`-scoped, time-boxed
 * delegation from the store's read-write token) → `presignUrl` — NOT
 * `getDownloadUrl` (which only decorates an already-known URL) or `head()`
 * (whose options take no `access`). The content route 302-redirects to the
 * result, so the TTL only needs to cover that immediate fetch.
 */
export async function signedDownloadUrl(pathname: string, ttlSeconds = 300): Promise<string> {
  const validUntil = Date.now() + ttlSeconds * 1000;
  const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'get',
    pathname,
    access: 'private',
    validUntil,
  });
  return presignedUrl;
}
