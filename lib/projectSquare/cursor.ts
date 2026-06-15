import type { ProjectDirectoryCursor } from '@/lib/repositories/projectRepository';
import { InvalidProjectSquareCursorError } from '@/lib/projectSquare/errors';

// Opaque keyset-cursor codec for the PROJECT SQUARE directory (Story 6.13 ·
// Subtask 6.13.2). The directory's deterministic order is `(createdAt desc, id
// desc)`, so the cursor carries exactly that pair, base64url-encoded so it is a
// single URL-safe token the client treats as opaque. The `|` separator is safe:
// an ISO-8601 timestamp never contains it and a cuid `id` is `[a-z0-9]` only.

/** Encode a `(createdAt, id)` keyset position into the opaque page token. */
export function encodeDirectoryCursor(cursor: ProjectDirectoryCursor): string {
  const payload = `${cursor.createdAt.toISOString()}|${cursor.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decode an opaque page token back into a keyset position. Throws
 * {@link InvalidProjectSquareCursorError} on anything that is not a
 * well-formed `<iso-timestamp>|<id>` pair (a tampered / truncated token), so the
 * route can answer 400 rather than silently resetting to page 1 (which would
 * mask a client bug and re-serve the first page).
 */
export function decodeDirectoryCursor(raw: string): ProjectDirectoryCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep <= 0) throw new InvalidProjectSquareCursorError();
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new InvalidProjectSquareCursorError();
  }
  return { createdAt, id };
}
