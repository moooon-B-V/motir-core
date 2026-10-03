import { PageLevelCursorInvalidError, levelPageSize } from '@motir/pages';

// The Archived pages list's keyset cursor (Story MOTIR-5755 · MOTIR-7420) — the
// tree level's codec applied to the list's own seek key. Opaque base64url of
// `[archivedAt, id]`, the last root served; anything this module did not issue
// is the tree level's `PAGE_CURSOR_INVALID`, so a client handles both lists'
// cursors the same way. The page size is the tree level's too (50, capped at
// 100) — `levelPageSize`.

/** The last root a page of the list served — `(archived_at, id)`, the order it seeks in. */
export interface ArchivedRootsCursor {
  archivedAt: Date;
  id: string;
}

export function encodeArchivedRootsCursor(cursor: ArchivedRootsCursor): string {
  return Buffer.from(JSON.stringify([cursor.archivedAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

/** Decode a cursor, refusing anything {@link encodeArchivedRootsCursor} did not produce. */
export function decodeArchivedRootsCursor(raw: string): ArchivedRootsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new PageLevelCursorInvalidError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    parsed[1] === ''
  ) {
    throw new PageLevelCursorInvalidError();
  }
  const archivedAt = new Date(parsed[0]);
  if (Number.isNaN(archivedAt.getTime())) throw new PageLevelCursorInvalidError();
  return { archivedAt, id: parsed[1] };
}

/** Rows per page of the list: the tree level's default and cap. */
export function archivedRootsLimit(requested?: number | null): number {
  return levelPageSize(requested);
}
