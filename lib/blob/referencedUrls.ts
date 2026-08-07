// Referenced-attachment parsing (Story 5.2 · Subtask 5.2.3; re-architected to
// ID-based by MOTIR-1668). Content attachments are now PRIVATE — they have no
// public blob URL. The editor inserts an upload into stored Markdown as its
// authenticated CONTENT PATH — `![name](/api/attachments/<id>/content)` for
// images, `[name](/api/attachments/<id>/content)` for files
// (lib/blob/uploadClient.ts) — so the embeds-are-attachments rule resolves at
// BODY-WRITE time by extracting the attachment IDS a body references and linking
// the matching rows. THIS helper is the pure string half (the sibling of
// lib/mentions/parse.ts): no Prisma, no IO, unit-testable anywhere. The DB half
// is attachmentsService.syncEditorLinks, which re-checks tenancy at the DB
// (findManyByIds is workspace-scoped — defence in depth, finding #26).
//
// Matching is construct-agnostic ON PURPOSE: any occurrence of a content path
// counts (embed, link, bare paste), mirroring the substring `contains` probe the
// unlink path uses for "still referenced elsewhere" — extraction and the
// keep-linked check ({@link attachmentContentPath}) must agree on what
// "referenced" means, or an edit could unlink a file the body still displays.

/**
 * The PRE-MIGRATION public host suffix (`<storeId>.public.blob.vercel-storage.com`).
 * Used by the AVATAR path — avatars are PUBLIC (a profile picture renders
 * everywhere with no per-item auth), so they keep a public URL and the
 * host+prefix validation below. Content attachments no longer use it.
 *
 * ⚠️ MOTIR-2389 moved new public assets onto the S3 public bucket, so this is
 * no longer the host anything is WRITTEN to — it is kept because `User.image`
 * rows written before the move still carry it, and those objects are copied
 * across at the SAME key by MOTIR-2401. Retiring it means rewriting those rows;
 * see the bug filed alongside MOTIR-2389.
 */
export const BLOB_PUBLIC_HOST_SUFFIX = '.public.blob.vercel-storage.com';

/**
 * The authenticated content path an attachment is served + embedded under
 * (MOTIR-1667). The single source of truth for both the DTO/embed value and the
 * keep-linked substring probe — they MUST agree.
 */
export function attachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

/** An attachment content path in a Markdown body → its id. cuid: [a-z0-9]+. */
const CONTENT_PATH_RE = /\/api\/attachments\/([a-z0-9]+)\/content/gi;

/**
 * Extract the attachment IDS a Markdown body references via their content path,
 * DEDUPED in first-seen order (the parseMentionIds convention). Null/undefined
 * bodies extract to []. Tenancy is enforced at the DB (findManyByIds is
 * workspace-scoped), so a foreign/cross-workspace id extracts here but can never
 * link (or unlink) a row.
 */
export function extractReferencedAttachmentIds(bodyMd: string | null | undefined): string[] {
  if (!bodyMd) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of bodyMd.matchAll(CONTENT_PATH_RE)) {
    const id = match[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The multi-body form: one issue write can carry several Markdown bodies
 * (description + explanation; a root comment + its replies on a thread delete).
 * Extracts each and merges, deduped in first-seen order.
 */
export function extractReferencedAttachmentIdsFromBodies(
  bodies: ReadonlyArray<string | null | undefined>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    for (const id of extractReferencedAttachmentIds(body)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * The per-USER avatar prefix an avatar upload writes under (Story 8.8 ·
 * Subtask 8.8.21) — `avatars/<userId>/…`. The personal analogue of the
 * `attachments/<workspaceId>/` attachment prefix above: an avatar is account
 * substrate (the account-settings area has no workspace/access axis), so it is
 * keyed by the owning USER, not a workspace. The avatar UPLOAD route writes the
 * blob here; `usersService.updateProfile` accepts an `image` URL only if it
 * lands here for THAT user (so user A can never point their avatar at user B's
 * — or any foreign — blob).
 */
export function avatarBlobPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

/**
 * True iff `url` is one of OUR public-bucket uploads under the calling user's
 * own avatar prefix. Used to (a) GATE an `image` update to a real own-avatar
 * URL, and (b) decide whether a REPLACED/removed prior `image` is ours to
 * delete — a provider URL from an OAuth signup (e.g. a Google avatar) is NOT
 * ours and must never be deleted. A malformed / non-`https` / foreign-host /
 * wrong-prefix URL returns false (never throws).
 *
 * TWO origins are accepted, and both are load-bearing (MOTIR-2389):
 *  - the CONFIGURED public bucket origin (`MOTIR_S3_PUBLIC_BASE_URL`) — what
 *    `putPublicAsset` returns today, so a fresh upload passes the gate;
 *  - the LEGACY Vercel public host — what every `User.image` written before the
 *    provider move still carries, so an existing avatar keeps rendering and
 *    stays garbage-collectable instead of being orphaned by the swap.
 *
 * Widening this is NOT a security relaxation: the owning-user check below is
 * what scopes an avatar to its user, and it applies identically to both.
 */
export function isOwnAvatarBlobUrl(url: string | null | undefined, userId: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const key = ownPublicAssetKey(url, parsed);
  if (key === null) return false;
  // startsWith, never includes: the key's tail is a user-supplied FILENAME, so
  // a containment check would let `avatars/<b>/x-avatars-<a>-y.png` read as A's.
  return key.startsWith(avatarBlobPrefix(userId));
}

/**
 * A public-asset URL → its object KEY, or null when the URL is not one of ours.
 * The single derivation both the avatar GATE (above) and the avatar GC
 * (`deletePublicAsset`) use, so they can never disagree about what a URL means.
 *
 * It lives HERE rather than beside the S3 client so this module stays
 * dependency-free — it is the pure string half of the blob seam, safe to pull
 * into any bundle.
 *
 * A path-style endpoint puts the BUCKET in the path
 * (`https://host/motir-public/avatars/…`), so the configured base URL's own
 * path is stripped before the key is returned; otherwise the bucket segment
 * would defeat the prefix check above.
 */
export function publicAssetKeyFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return ownPublicAssetKey(url, parsed);
}

function ownPublicAssetKey(url: string, parsed: URL): string | null {
  const key = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (!key) return null;

  const configured = process.env['MOTIR_S3_PUBLIC_BASE_URL'];
  if (configured) {
    const base = configured.replace(/\/+$/, '');
    if (url.startsWith(`${base}/`)) {
      let basePath: string;
      try {
        basePath = decodeURIComponent(new URL(base).pathname).replace(/^\/+|\/+$/g, '');
      } catch {
        return null;
      }
      if (!basePath) return key;
      return key.startsWith(`${basePath}/`) ? key.slice(basePath.length + 1) : null;
    }
  }

  // A pre-migration Vercel public URL — the key is the pathname as-is.
  if (parsed.hostname.toLowerCase().endsWith(BLOB_PUBLIC_HOST_SUFFIX)) return key;
  return null;
}
