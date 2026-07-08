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
 * The public Vercel-Blob host suffix (`<storeId>.public.blob.vercel-storage.com`).
 * Still used by the AVATAR path — avatars are PUBLIC (a profile picture renders
 * everywhere with no per-item auth), so they keep a public blob URL and the
 * host+prefix validation below. Content attachments no longer use it.
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
 * True iff `url` is one of OUR Vercel-Blob uploads under the calling user's own
 * avatar prefix — the same host-suffix + pathname-prefix shape
 * {@link extractReferencedBlobUrls} uses, scoped to a single owner instead of a
 * Markdown body. Used to (a) GATE an `image` update to a real own-avatar URL,
 * and (b) decide whether a REPLACED/removed prior `image` is ours to `del` — a
 * provider URL from an OAuth signup (e.g. a Google avatar) is NOT ours and must
 * never be deleted. A malformed / non-`https` / foreign-host / wrong-prefix URL
 * returns false (never throws).
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
  if (!parsed.hostname.toLowerCase().endsWith(BLOB_PUBLIC_HOST_SUFFIX)) return false;
  return parsed.pathname.startsWith(`/${avatarBlobPrefix(userId)}`);
}
