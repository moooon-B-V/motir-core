import { del, put } from '@vercel/blob';

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
