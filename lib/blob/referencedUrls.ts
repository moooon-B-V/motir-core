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
 * no longer the host anything is WRITTEN to. MOTIR-2404 then stopped `User.image`
 * persisting an absolute URL at all — it now stores the object KEY — so nothing
 * this codebase writes carries this host in either form.
 *
 * It is kept for READ tolerance only: a row written before either change still
 * carries it, and {@link storedAssetUrl} passes such a value through untouched
 * while {@link storedAssetKey} still resolves it to a key the GC can delete.
 * That tolerance is what let MOTIR-2404 ship with no backfill. Retiring the
 * constant is MOTIR-2393's (the abandoned-Vercel-path deletion), whose `BLOB_`
 * grep already reaches this line.
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
 * True iff `stored` refers to one of OUR public-bucket uploads under the calling
 * user's own avatar prefix. Used to (a) GATE an `image` update to a real
 * own-avatar reference, and (b) decide whether a REPLACED/removed prior `image`
 * is ours to delete — a provider URL from an OAuth signup (e.g. a Google avatar)
 * is NOT ours and must never be deleted. Anything else returns false (never
 * throws).
 *
 * ⚠️ It takes a STORED REFERENCE, not a URL (MOTIR-2404). `User.image` now holds
 * the object KEY for our own avatars, so the three accepted forms are:
 *  - a bare KEY (`avatars/<userId>/…`) — what `uploadAvatar` returns today;
 *  - the CONFIGURED public bucket origin (`MOTIR_S3_PUBLIC_BASE_URL`) — what it
 *    returned between MOTIR-2389 and MOTIR-2404;
 *  - the LEGACY Vercel public host — what it returned before MOTIR-2389.
 *
 * All three are read tolerance, and the two absolute ones are why this card
 * needed no backfill. Accepting them is NOT a security relaxation: the
 * owning-user prefix check below is what scopes an avatar to its user, and it
 * applies identically to all three because each is reduced to a key FIRST.
 */
export function isOwnAvatarRef(stored: string | null | undefined, userId: string): boolean {
  if (!stored) return false;
  const key = ownStoredAssetKey(stored);
  if (key === null) return false;
  // startsWith, never includes: the key's tail is a user-supplied FILENAME, so
  // a containment check would let `avatars/<b>/x-avatars-<a>-y.png` read as A's.
  return key.startsWith(avatarBlobPrefix(userId));
}

/**
 * A stored public-asset reference → the ABSOLUTE URL a browser fetches it from.
 * The resolution half of MOTIR-2404, and the reason storing a key costs no
 * external contract: every DTO that carries a user image runs its stored value
 * through this, so every consumer keeps receiving an absolute URL exactly as it
 * did when the column held one.
 *
 * An ABSOLUTE input is returned UNCHANGED, and that arm is load-bearing rather
 * than defensive: `User.image` is permanently polymorphic because better-auth's
 * Google provider writes a `googleusercontent.com` URL at signup through an
 * adapter this repo does not own. Since a foreign absolute URL must work
 * forever, a legacy own-avatar URL works for free — which is what let the
 * storage change ship against live rows with no migration and no dual-read.
 *
 * A RELATIVE input is a key and is resolved against the configured public base.
 * With no base configured the key is returned as-is rather than throwing: this
 * runs inside DTO mappers on every read path, and an unconfigured store must
 * degrade to a broken image, never to a 500 on the board.
 */
export function storedAssetUrl(stored: string): string;
export function storedAssetUrl(stored: null | undefined): null;
export function storedAssetUrl(stored: string | null | undefined): string | null;
export function storedAssetUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (isAbsoluteRef(stored)) return stored;
  const base = process.env['MOTIR_S3_PUBLIC_BASE_URL'];
  if (!base) return stored;
  return `${base.replace(/\/+$/, '')}/${stored.replace(/^\/+/, '')}`;
}

/**
 * A stored public-asset reference → the object KEY, or null when it is not ours.
 * What the avatar GC deletes by. The counterpart to {@link storedAssetUrl}: that
 * one is for showing a value, this one is for acting on the object behind it,
 * and both accept the same three forms so they can never disagree about what a
 * stored value means.
 */
export function storedAssetKey(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return ownStoredAssetKey(stored);
}

/**
 * Does this stored value carry a URI scheme? The discriminator between the two
 * storage forms, and it is `new URL` rather than a regex on purpose: a key is
 * always `avatars/<id>/<file>`, so the `/` precedes any `:` in it and the parse
 * fails, while anything with a real scheme parses. Getting this wrong in the
 * permissive direction is what would let `javascript:…` reach an `<img src>`,
 * which is why the gate below re-checks for `https:` rather than trusting this.
 */
function isAbsoluteRef(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** The shared reduction both public entry points above are built from. */
function ownStoredAssetKey(stored: string): string | null {
  if (isAbsoluteRef(stored)) {
    let parsed: URL;
    try {
      parsed = new URL(stored);
    } catch {
      return null;
    }
    // https only — a `javascript:`/`data:` value parses perfectly well, and this
    // is the line that stops one being stored and later rendered.
    if (parsed.protocol !== 'https:') return null;
    return ownPublicAssetKey(stored, parsed);
  }
  // A bare key. Reject anything that could escape its own prefix before the
  // owning-user check reads it: a leading slash or a `..` segment would make
  // `startsWith(avatars/<me>/)` true for a path that does not resolve there.
  if (stored.startsWith('/')) return null;
  if (stored.split('/').includes('..')) return null;
  return stored;
}

/**
 * An ABSOLUTE public-asset URL → its object KEY, or null when it is not one of
 * ours. The shared derivation behind the avatar GATE, the avatar GC and the
 * display resolver above, so none of the three can disagree about what a stored
 * value means.
 *
 * It lives HERE rather than beside the S3 client so this module stays
 * dependency-free — it is the pure string half of the blob seam, safe to pull
 * into any bundle. (That is also why the resolver above reads
 * `MOTIR_S3_PUBLIC_BASE_URL` from the environment directly rather than calling
 * `publicBaseUrl()`: importing `lib/blob/s3.ts` would drag the AWS SDK into
 * every bundle that maps a user DTO.)
 *
 * A path-style endpoint puts the BUCKET in the path
 * (`https://host/motir-public/avatars/…`), so the configured base URL's own
 * path is stripped before the key is returned; otherwise the bucket segment
 * would defeat the prefix check above.
 */
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
