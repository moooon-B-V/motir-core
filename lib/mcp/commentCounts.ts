// The per-row COMMENT-COUNT block the MCP work-item reads attach (MOTIR-2001) —
// the transport half of `commentsService.getCommentCountsForItems`, and the
// direct sibling of `dependencyEdges.ts`'s `attachEdges` / `edgeMarker`.
//
// ONE seam, FIVE tools: `get_work_item` (on the ITEM), `list_ready`,
// `search_work_items`, `next_ready` and `claim_next_ready` all attach the
// IDENTICAL `commentCount: number` and render the IDENTICAL text marker, so a
// client learns the field once and renders every read with one renderer.
//
// WHY a count and not a thread: `get_work_item_activity` (MOTIR-1999) is where a
// card's discussion lives, and it must be CALLED to discover whether there is
// one. This is the signal that makes that call worth making — an agent opens the
// thread on the cards that have one instead of paying a round-trip per card to
// find out, or never asking at all. A count, not a boolean: `0` already IS the
// "no discussion" answer, and a count is what Jira / Linear / GitHub badge a row
// with.
//
// The block is attached HERE, at the transport, and deliberately NOT added to
// `IssueDetailDto` / `ReadyItemDto` / `WorkItemListItemDto` — the same rule, for
// the same reason, that `dependencyEdges.ts` records at length: those are the
// wire shapes of the issue-detail page, the `/ready` page and the `/issues` List,
// which do not render a comment badge, and widening `IssueDetailDto` would break
// every exact-`toEqual` route-shape test that reads the aggregate back. Whether a
// list row or a board card SHOULD badge a comment count is a real question — it
// is a UI question, owned by its own surface, not smuggled in behind an MCP
// projection. The transport is the layer that has a consumer.

/** Shared tail for all five tools' `tools/list` descriptions — one sentence, one truth. */
export const COMMENT_COUNT_DESCRIPTION =
  'Each returned work item also carries `commentCount` — how many comments it ' +
  'holds, replies included (the same total `get_work_item_activity` pages ' +
  'through). Always present as a number, `0` when there is no discussion, so a ' +
  'client can skip the activity read for the cards that have none.';

/**
 * `get_work_item`'s one-clause scope note, appended after
 * {@link COMMENT_COUNT_DESCRIPTION}: the aggregate carries the count on the ITEM
 * and not on its child summaries. A child badge would invite a client to render
 * a whole subtree's discussion state from a read whose job is this ONE card —
 * and the list reads already answer that question per row.
 */
export const ITEM_ONLY_COMMENT_COUNT_NOTE =
  'On this aggregate it rides the item itself, not the child rows.';

/**
 * Attach the comment count to a batch of rows the caller has already read counts
 * for.
 *
 * TOTAL by construction: a row the projection returned no entry for still gets
 * `0`, never `undefined` — the promise {@link COMMENT_COUNT_DESCRIPTION} makes
 * to every client, held here rather than at each call site.
 */
export function attachCommentCounts<T extends { id: string }>(
  rows: T[],
  counts: Record<string, number>,
): (T & { commentCount: number })[] {
  return rows.map((row) => ({ ...row, commentCount: counts[row.id] ?? 0 }));
}

/**
 * The compact marker appended to a row's human-readable text line, so a client
 * that ignores `structuredContent` still SEES that a card has a discussion.
 *
 * Empty string at zero (and for an absent projection), so a discussion-free list
 * renders byte-identical to what it rendered before this field existed — the
 * same promise `edgeMarker` holds for an edge-free row.
 */
export function commentCountMarker(count: number | undefined): string {
  if (!count) return '';
  return ` · ${count} comment${count === 1 ? '' : 's'}`;
}
