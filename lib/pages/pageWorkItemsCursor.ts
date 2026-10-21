import { PageLevelCursorInvalidError, levelPageSize } from '@motir/pages';
import type { PageWorkItemsSeek } from '@/lib/repositories/pageWorkItemLinkRepository';

// The page-side hand-link read's keyset cursor (Story MOTIR-7567 · MOTIR-9198).
// Opaque base64url of `['link', createdAt, id]` — the last LINK row served.
//
// ⚠️ THREE ELEMENTS ON PURPOSE. The work item's Pages read mints `[updatedAt, id]`;
// a pair here would decode that cursor cleanly and seek on a column it never
// described. The leading `'link'` band is what makes a foreign cursor the tree
// level's `PAGE_CURSOR_INVALID` instead of a silently wrong page.

export function encodePageWorkItemsCursor(cursor: PageWorkItemsSeek): string {
  return Buffer.from(JSON.stringify(['link', cursor.createdAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

/** Decode a cursor, refusing anything {@link encodePageWorkItemsCursor} did not produce. */
export function decodePageWorkItemsCursor(raw: string): PageWorkItemsSeek {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new PageLevelCursorInvalidError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== 'link' ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    parsed[2] === ''
  ) {
    throw new PageLevelCursorInvalidError();
  }
  const createdAt = new Date(parsed[1]);
  if (Number.isNaN(createdAt.getTime())) throw new PageLevelCursorInvalidError();
  return { createdAt, id: parsed[2] };
}

/** Rows per page of the read: the tree level's default and cap. */
export function pageWorkItemsLimit(requested?: number | null): number {
  return levelPageSize(requested);
}
