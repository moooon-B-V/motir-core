import { randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { privateBucket, publicBaseUrl, publicBucket, s3Client } from '@/lib/blob/s3';

// The blob-storage adapter (Subtask 2.3.7; delete added in 5.2.7; moved onto
// the S3 API by MOTIR-2389) — the ONE place the app talks to object storage,
// so swapping providers is a single-file change (the seam's stated charter,
// now collected on). Everything else calls through these exports; tests mock
// THIS module so nothing hits the network.
//
// Provider: an S3-compatible store, two buckets (public assets / private
// content) — `docs/decisions/application-hosting.md` Q2 and
// `attachment-access-control.md` Amendment 2. Bucket + credential policy lives
// in `lib/blob/s3.ts`; this file is object operations only.
//
// ⚠️ TWO of these functions mint PERMISSION rather than move bytes, and that is
// where a provider swap goes wrong quietly:
//   - `signedDownloadUrl` → a presigned GET, 300 s (the ADR's §5 TTL, unchanged).
//   - `mintPrivateUploadToken` → a presigned PUT whose CONTENT TYPE is bound
//     INTO the signature. A presigned PUT carries only what the SIGNER bound;
//     see that function's comment for why `signableHeaders` is not optional.

/** Where an upload lands. Public assets are fetchable; private ones are not. */
type Store = 'public' | 'private';

function bucketFor(store: Store): string {
  return store === 'public' ? publicBucket() : privateBucket();
}

/**
 * `shot.png` → `shot-k3f9a1.png`: the `addRandomSuffix` shape the Vercel store
 * applied server-side, reimplemented here because S3 stores exactly the key it
 * is given. It keeps two same-named uploads from clobbering each other, and
 * infixes BEFORE the extension so extension-based content-type sniffing (the
 * E2E fulfiller, a browser download) still works.
 */
function withRandomSuffix(pathname: string): string {
  const suffix = randomBytes(5).toString('hex');
  const dot = pathname.lastIndexOf('.');
  if (dot <= pathname.lastIndexOf('/')) return `${pathname}-${suffix}`;
  return `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
}

/**
 * Normalize the accepted body types to something `PutObjectCommand` can size.
 * A `File`/`Blob` is NOT a valid S3 body in Node, and a stream body would need
 * an explicit `ContentLength`; a Buffer gives the SDK both.
 */
async function toBuffer(body: File | Blob | ArrayBuffer | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(await body.arrayBuffer());
}

async function putObject(
  store: Store,
  pathname: string,
  body: File | Blob | ArrayBuffer | Buffer,
  contentType: string,
): Promise<string> {
  const key = withRandomSuffix(pathname);
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucketFor(store),
      Key: key,
      Body: await toBuffer(body),
      ContentType: contentType,
    }),
  );
  return key;
}

export interface PutResult {
  url: string;
}

/**
 * Legacy public put (Subtask 2.3.7). Retained with its signature intact — it
 * has NO remaining caller (`git grep putAttachment -- app lib components` finds
 * only this file), and removing a dead export belongs to the abandoned-path
 * card MOTIR-2393, not here.
 */
export async function putAttachment(
  pathname: string,
  body: File | Blob | ArrayBuffer | Buffer,
  contentType: string,
): Promise<PutResult> {
  const key = await putObject('public', pathname, body, contentType);
  return { url: `${publicBaseUrl()}/${key}` };
}

/**
 * Delete one stored PRIVATE object by its key (Subtask 5.2.7; 5.2.2's panel
 * delete is the other caller). S3's delete-object is idempotent — deleting an
 * already-gone key succeeds — which is what makes the GC's blob-before-row
 * ordering safe to re-run after a partial failure.
 *
 * (The parameter is named `url` for signature compatibility; every caller has
 * passed a `blobPathname` KEY since MOTIR-1665 made content private.)
 */
export async function deleteAttachmentBlob(url: string): Promise<void> {
  await s3Client().send(new DeleteObjectCommand({ Bucket: privateBucket(), Key: url }));
}

/**
 * Delete a PUBLIC-store asset (an avatar) by its object KEY (MOTIR-1673; took a
 * URL until MOTIR-2404). `User.image` now stores the key, so the caller has one
 * directly and the derivation that used to live here moved to
 * `storedAssetKey` — beside the avatar GATE it must agree with, and where a
 * legacy absolute row is reduced to the same key its object was copied across
 * at (MOTIR-2401).
 *
 * An empty key is a no-op rather than an error: the caller already gates on
 * `isOwnAvatarRef`, and deleting nothing is the safe outcome if that ever
 * changes. Idempotent — S3's delete-object succeeds on an already-gone key.
 */
export async function deletePublicAsset(key: string): Promise<void> {
  if (!key) return;
  await s3Client().send(new DeleteObjectCommand({ Bucket: publicBucket(), Key: key }));
}

// ── Access-controlled attachments (MOTIR-1665) — the two-store split ──────────
// Avatars / public assets go to the PUBLIC bucket (a profile picture renders
// everywhere with no per-item auth context → a directly-fetchable URL).
// Content attachments (comment/description embeds, panel files, acceptance
// video/trace) go to the PRIVATE bucket and are served ONLY through the
// authenticated content route via `signedDownloadUrl`.

export interface PrivatePutResult {
  /** The object key. A private object has no world-readable URL; the content
   *  route mints a short-lived signed URL from this via `signedDownloadUrl`. */
  pathname: string;
}

export interface PublicPutResult {
  /** The object key. Resolve it for display with `storedAssetUrl`. */
  key: string;
}

/**
 * Upload a PUBLIC asset (avatars) to the public bucket. Returns the object KEY,
 * not a URL (MOTIR-2404) — the object is still world-readable and still rendered
 * with no per-item authorization; what changed is that the ORIGIN is no longer
 * baked into the value the caller persists.
 *
 * That is the same shape `putPrivateAttachment` returns below, and for the same
 * reason `Attachment.blobPathname` has always stored a key: a key means the same
 * object wherever the bucket lives, so a provider or bucket change is a config
 * change rather than a data migration. Composing the URL is `storedAssetUrl`'s
 * job, at the DTO boundary, on read.
 */
export async function putPublicAsset(
  pathname: string,
  body: File | Blob | ArrayBuffer | Buffer,
  contentType: string,
): Promise<PublicPutResult> {
  return { key: await putObject('public', pathname, body, contentType) };
}

/**
 * Upload a PRIVATE content attachment to the private bucket. Returns the object
 * KEY, never a URL — the bytes are reachable only through the authenticated
 * content route.
 */
export async function putPrivateAttachment(
  pathname: string,
  body: File | Blob | ArrayBuffer | Buffer,
  contentType: string,
): Promise<PrivatePutResult> {
  return { pathname: await putObject('private', pathname, body, contentType) };
}

/** The key's last segment — the filename a download should land under. */
function basename(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

/**
 * Mint a short-lived signed GET URL for a PRIVATE object — an **S3 presigned
 * GET** (MOTIR-2389, replacing `@vercel/blob`'s `issueSignedToken` →
 * `presignUrl` delegation, which has no counterpart outside that vendor). The
 * content route 302-redirects to the result, so the TTL only needs to cover
 * that immediate fetch; it stays at the ADR's 300 s.
 *
 * `download: true` binds `ResponseContentDisposition` INTO the signature rather
 * than appending a query switch afterwards — on S3 an unsigned response-header
 * override is simply rejected, so the old `?download=1` suffix would not have
 * survived the move.
 *
 * ⚠️ ONE code path, deliberately — there is no `E2E_TEST_BLOB` branch here and
 * re-adding one would silently un-test the seam (MOTIR-2395). MOTIR-2389 left
 * such a branch because a presigned URL is derived CLIENT-side and points at a
 * host the BROWSER fetches, which the in-process transport in `lib/blob/s3.ts`
 * cannot reach; the consequence was that every "private" E2E download resolved
 * through a fabricated, signature-free URL, so the suite asserted nothing about
 * access control. The interception now happens where the fetch actually is — a
 * Playwright `page.route` on the endpoint host (`tests/e2e/_helpers/object-store.ts`),
 * which refuses a request carrying no `X-Amz-Signature` exactly as S3 does. So
 * the URL the E2E exercises is minted by this line, not around it.
 */
export async function signedDownloadUrl(
  pathname: string,
  opts: { ttlSeconds?: number; download?: boolean } = {},
): Promise<string> {
  const { ttlSeconds = 300, download = false } = opts;
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: privateBucket(),
      Key: pathname,
      ...(download
        ? { ResponseContentDisposition: `attachment; filename="${basename(pathname)}"` }
        : {}),
    }),
    { expiresIn: ttlSeconds },
  );
}

// ── CLIENT-DIRECT upload for large private artifacts (MOTIR-1681) ─────────────
// A server-proxied `putPrivateAttachment` streams the bytes THROUGH the
// application, whose request body is capped well below a full acceptance video
// (the allowlist permits up to 100MB). The acceptance publish instead mints a
// scoped, single-object upload grant here, a trusted CI job PUTs the blob
// DIRECTLY with it, then reports the key back (re-validated via
// `headPrivateBlob`).

/**
 * Mint a short-lived **presigned PUT URL** bound to EXACTLY `pathname` and
 * `opts.contentType`. A holder can only write that one private object, as that
 * one content type.
 *
 * ⚠️ `signableHeaders` is load-bearing, not a tuning knob. A presigned PUT
 * carries only the metadata the SIGNER bound into it, and by default the
 * presigner DROPS `ContentType` from the signature entirely — leaving the
 * uploader free to send anything, so every client-uploaded object could land as
 * `application/octet-stream` and every embedded image would render as a
 * download. Forcing `content-type` into `X-Amz-SignedHeaders` makes the bound
 * type part of the signature: an uploader that sends a different one is
 * rejected. This is the behavioural difference `application-hosting.md` §3 and
 * `attachment-access-control.md` Amendment 2 pin by name, and `notes.html` #207
 * is the incident where the same class of unsigned metadata produced objects a
 * later reader refused forever.
 *
 * ⚠️ `opts.maxBytes` has NO presigned-PUT equivalent — a size ceiling would
 * require a POST policy, a different client contract. It is NOT silently
 * dropped: the register step re-reads the object's AUTHORITATIVE size via
 * {@link headPrivateBlob} and rejects an over-cap artifact
 * (`acceptanceEvidenceService.recordFromPathnames` → `FileTooLargeError`), so
 * the cap is enforced server-side after the write rather than at the grant. The
 * value stays in the signature for the caller's own up-front check, which is
 * what `assertWithinMintedCap` uses it for.
 */
export async function mintPrivateUploadToken(
  pathname: string,
  opts: { contentType: string; maxBytes: number; ttlSeconds?: number },
): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: privateBucket(),
      Key: pathname,
      ContentType: opts.contentType,
    }),
    {
      expiresIn: opts.ttlSeconds ?? 300,
      signableHeaders: new Set(['content-type']),
    },
  );
}

export interface BlobHead {
  size: number;
  contentType: string;
}

/**
 * Read the AUTHORITATIVE size + contentType of a private object by its key —
 * the register step HEADs each client-uploaded artifact to confirm it exists
 * (the upload actually happened) and to read its real metadata, never trusting
 * the values a caller reports. Returns null when the object is absent.
 */
export async function headPrivateBlob(pathname: string): Promise<BlobHead | null> {
  try {
    const result = await s3Client().send(
      new HeadObjectCommand({ Bucket: privateBucket(), Key: pathname }),
    );
    return {
      size: result.ContentLength ?? 0,
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  } catch {
    return null;
  }
}
