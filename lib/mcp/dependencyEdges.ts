import type { WorkItemDependencyEdgesDto } from '@/lib/dto/workItems';

// The per-row DEPENDENCY-EDGE block the MCP LIST reads attach (Subtask 7.9.0f /
// MOTIR-1842) — the transport half of `workItemsService.getDependencyEdgesForItems`.
//
// ONE seam, THREE tools: `list_ready` and `search_work_items` attach the IDENTICAL
// `dependencies: { blockedBy, blocks }` block to every `structuredContent` row and
// render the same compact text marker, so a client (the 7.9.16 CLI edge column)
// renders both lists with ONE renderer and never branches per tool. `get_work_item`
// (7.9.16b / MOTIR-1848) attaches the SAME block to each CHILD of the detail
// aggregate — the sibling sub-graph the CLI's build-order WAVE view is computed
// from, which the aggregate's own `children` (a `WorkItemSummaryDto[]`) does not
// carry.
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
