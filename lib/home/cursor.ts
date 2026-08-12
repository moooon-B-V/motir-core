import type { HomeCursor } from '@/lib/repositories/workItemRepository';

// The opaque page token for Home's two personal reads (Story MOTIR-2649 ·
// Subtask MOTIR-2651). Encodes the KEYSET the reads order by — `(updatedAt, id)`
// — so a caller resumes at a POSITION rather than an offset, and the page
// boundary survives items being updated underneath the reader while they page.
//
// Opaque on purpose: base64url of `<iso>|<id>`. The caller round-trips it and
// never parses it, so the keyset can gain a third column later without a wire
// change. A malformed or truncated token decodes to `null` — the read then
// serves page one, which is the safe degradation for a token that can only ever
// arrive from a URL a human edited or a stale bookmark.

/** Encode a row's `(updatedAt, id)` position into the wire token. */
export function encodeHomeCursor(cursor: HomeCursor): string {
  return Buffer.from(`${cursor.updatedAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decode a wire token back to a keyset, or `null` when it is absent or does not
 * parse. Never throws: an unusable cursor is page one, not a 500.
 */
export function decodeHomeCursor(token: string | null | undefined): HomeCursor | null {
  if (!token) return null;
  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = raw.indexOf('|');
  if (separator <= 0) return null;
  const iso = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (id.length === 0) return null;
  const updatedAt = new Date(iso);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, id };
}
