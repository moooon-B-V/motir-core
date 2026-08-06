import type { WorkItemDependencyEdgesDto } from '@/lib/dto/workItems';

// The per-row DEPENDENCY-EDGE block the MCP LIST reads attach (Subtask 7.9.0f /
// MOTIR-1842) — the transport half of `workItemsService.getDependencyEdgesForItems`.
//
// ⚠️ HISTORY, not a live asymmetry (corrected by MOTIR-2229). This comment used
// to read "ONE seam, TWO tools" — `list_ready` and `search_work_items` carried
// the block and `get_work_item` did not. Nobody decided that; the block was
// added where it was needed and the third tool was never revisited, and the
// disagreement stayed invisible until a card was planned on the assumption all
// three agreed (MOTIR-1849, the defect Story 11.6 exists to end). 7.9.16b
// (MOTIR-1848) added the child block, and 11.6.3 removed the place where such a
// shape could be authored by hand at all: `dependencies` now comes from v1's
// `dependencyEdgesSchema` on every row that carries it, so the three tools
// cannot drift about it again.
//
// What the block still IS: the IDENTICAL `dependencies: { blockedBy, blocks }`
// on every `structuredContent` row of `list_ready` and `search_work_items`, plus
// the same block on each CHILD of `get_work_item`'s detail aggregate — the
// sibling sub-graph the CLI's build-order WAVE view is computed from, which the
// aggregate's own `children` (a `WorkItemSummaryDto[]`) does not carry. One
// renderer reads all three and never branches per tool (the 7.9.16 CLI edge
// column).
//
// The block is attached HERE, at the transport, and deliberately NOT added to
// `ReadyItemDto` / `WorkItemListItemDto` / `IssueDetailDto.children`: those are the
// wire shapes of the `/ready` page, the `/issues` List, and the issue-detail PAGE,
// which render dependency state their own way (the readiness banner, the
// relationships panel). Widening them would ship an edge payload to web surfaces
// that do not consume it — and, for `IssueDetailDto`, would break every
// exact-`toEqual` route-shape test that reads the aggregate back. The transport is
// the layer that has a consumer.

/** Shared tail for both tools' `tools/list` descriptions — one sentence, one truth. */
export const EDGE_BLOCK_DESCRIPTION =
  'Every row also carries `dependencies: { blockedBy, blocks }` — the item’s ' +
  'dependency edges in both directions, each entry `{ key, title, status }` with ' +
  '`key` the `PROD-<n>` identifier. Both arrays are always present (empty when the ' +
  'item has no edges in that direction).';

/**
 * The same sentence for `get_work_item`, scoped to the CHILD rows it attaches the
 * block to (the item's OWN edges already ship as the aggregate's richer
 * `blockedBy` / `blocks` link groups, which carry link ids — the child block is
 * the SIBLING sub-graph, and it is what makes a build order derivable in one call).
 */
export const CHILD_EDGE_BLOCK_DESCRIPTION =
  'Every CHILD row also carries `dependencies: { blockedBy, blocks }` — that ' +
  'child’s dependency edges in both directions, each entry `{ key, title, status }` ' +
  'with `key` the `PROD-<n>` identifier. Both arrays are always present (empty when ' +
  'the child has no edges in that direction), so the children’s build ORDER is ' +
  'derivable from this one call without a per-child read.';

/**
 * Attach the edge block to a batch of rows the caller has already read edges for.
 *
 * TOTAL by construction: a row the reader returned no entry for still gets two
 * EMPTY arrays, never `undefined` — the promise
 * {@link EDGE_BLOCK_DESCRIPTION} / {@link CHILD_EDGE_BLOCK_DESCRIPTION} make to
 * every client, held here rather than at each call site.
 */
export function attachEdges<T extends { id: string }>(
  rows: T[],
  edges: Record<string, WorkItemDependencyEdgesDto>,
): (T & { dependencies: WorkItemDependencyEdgesDto })[] {
  return rows.map((row) => ({
    ...row,
    dependencies: edges[row.id] ?? { blockedBy: [], blocks: [] },
  }));
}

/**
 * The compact edge marker appended to a row's human-readable text line, so a
 * client that ignores `structuredContent` still SEES the graph (Principle #14 —
 * a plan IS its dependency graph). Empty string when the item has no edges, so
 * an edge-free list reads exactly as it did before.
 */
export function edgeMarker(edges: WorkItemDependencyEdgesDto | undefined): string {
  if (!edges) return '';
  const parts: string[] = [];
  if (edges.blockedBy.length > 0) {
    parts.push(`blocked by ${edges.blockedBy.map((e) => e.key).join(', ')}`);
  }
  if (edges.blocks.length > 0) {
    parts.push(`blocks ${edges.blocks.map((e) => e.key).join(', ')}`);
  }
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}
