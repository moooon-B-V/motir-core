import { PageLevelCursorInvalidError, levelPageSize } from '@motir/pages';
import type { WorkItemPagesSeek } from '@/lib/repositories/pageWorkItemLinkRepository';

// The work item's Pages read keyset cursor (Story MOTIR-7565 · MOTIR-7573) — the
// Archived pages list's codec applied to this read's seek key. Opaque base64url
// of `[updatedAt, id]`, the last page served; anything this module did not issue
// is the tree level's `PAGE_CURSOR_INVALID`. The page size is the tree level's
// (50, capped at 100) — `levelPageSize`, the `pages.md` §4 numbers.

export function encodeWorkItemPagesCursor(cursor: WorkItemPagesSeek): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

/** Decode a cursor, refusing anything {@link encodeWorkItemPagesCursor} did not produce. */
export function decodeWorkItemPagesCursor(raw: string): WorkItemPagesSeek {
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
  const updatedAt = new Date(parsed[0]);
  if (Number.isNaN(updatedAt.getTime())) throw new PageLevelCursorInvalidError();
  return { updatedAt, id: parsed[1] };
}

/** Rows per page of the read: the tree level's default and cap. */
export function workItemPagesLimit(requested?: number | null): number {
  return levelPageSize(requested);
}
