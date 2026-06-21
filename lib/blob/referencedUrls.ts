// Referenced-blob-URL parsing (Story 5.2 · Subtask 5.2.3). The editor inserts
// an upload into stored Markdown as a direct blob URL — `![name](url)` for
// images, `[name](url)` for files (lib/blob/uploadClient.ts) — so the
// embeds-are-attachments rule resolves at BODY-WRITE time by extracting the
// blob URLs a body references and linking the matching attachment rows. THIS
// helper is the pure string half (the sibling of lib/mentions/parse.ts): no
// Prisma, no IO, unit-testable anywhere. The DB half is
// attachmentsService.syncEditorLinks.
//
// Only OUR uploads qualify: a URL must sit on the Vercel-Blob public host AND
// carry the `attachments/<workspaceId>/` pathname prefix the uploader writes
// (lib/blob/uploader.ts via attachmentsService.uploadAttachment). A pasted
// foreign URL — another site, another store, another WORKSPACE's prefix —
// extracts to nothing, so it can never link (or unlink) a row. The
// workspace-scoped `findManyByBlobUrls` lookup re-checks tenancy at the DB
// (defence in depth — finding #26).
//
// Matching is construct-agnostic ON PURPOSE: any occurrence of a qualifying
// URL counts (embed, link, bare paste), mirroring the substring `contains`
// probe the unlink path uses for "still referenced elsewhere" — extraction
// and the keep-linked check must agree on what "referenced" means, or an
// edit could unlink a file the body still displays.

/**
 * The public Vercel-Blob host suffix (`<storeId>.public.blob.vercel-storage.com`).
 * Coupled to the storage adapter the same way lib/blob/uploader.ts is — an
 * S3/GCS swap (the adapter's stated enterprise seam) updates both together.
 */
export const BLOB_PUBLIC_HOST_SUFFIX = '.public.blob.vercel-storage.com';

/** Candidate URLs in a Markdown body: `https://` up to Markdown/HTML delimiters. */
const URL_CANDIDATE_RE = /https:\/\/[^\s<>()"'\]]+/g;

/**
 * Extract the blob URLs a Markdown body references that belong to THIS
 * workspace's uploads, DEDUPED in first-seen order (the parseMentionIds
 * convention). Null/undefined bodies extract to []. Malformed near-URLs are
 * body text, never an error.
 */
export function extractReferencedBlobUrls(
  bodyMd: string | null | undefined,
  workspaceId: string,
): string[] {
  if (!bodyMd) return [];
  const prefix = `/attachments/${workspaceId}/`;
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of bodyMd.matchAll(URL_CANDIDATE_RE)) {
    const candidate = match[0];
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (!parsed.hostname.toLowerCase().endsWith(BLOB_PUBLIC_HOST_SUFFIX)) continue;
    if (!parsed.pathname.startsWith(prefix)) continue;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      urls.push(candidate);
    }
  }
  return urls;
}

/**
 * The multi-body form: one issue write can carry several Markdown bodies
 * (description + explanation; a root comment + its replies on a thread
 * delete). Extracts each and merges, deduped in first-seen order.
 */
export function extractReferencedBlobUrlsFromBodies(
  bodies: ReadonlyArray<string | null | undefined>,
  workspaceId: string,
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    for (const url of extractReferencedBlobUrls(body, workspaceId)) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
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
