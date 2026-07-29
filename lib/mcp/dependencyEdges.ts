import type { WorkItemDependencyEdgesDto } from '@/lib/dto/workItems';

// The per-row DEPENDENCY-EDGE block the MCP LIST reads attach (Subtask 7.9.0f /
// MOTIR-1842) — the transport half of `workItemsService.getDependencyEdgesForItems`.
//
// ONE seam, TWO tools: `list_ready` and `search_work_items` attach the IDENTICAL
// `dependencies: { blockedBy, blocks }` block to every `structuredContent` row and
// render the same compact text marker, so a client (the 7.9.16 CLI edge column)
// renders both lists with ONE renderer and never branches per tool.
//
// The block is attached HERE, at the transport, and deliberately NOT added to
// `ReadyItemDto` / `WorkItemListItemDto`: those are the wire shapes of the
// `/ready` page and the `/issues` List, which render dependency state their own
// way (the readiness banner, the relationships panel). Widening them would ship
// an edge payload to web surfaces that do not consume it. The transport is the
// layer that has a consumer.

/** Shared tail for both tools' `tools/list` descriptions — one sentence, one truth. */
export const EDGE_BLOCK_DESCRIPTION =
  'Every row also carries `dependencies: { blockedBy, blocks }` — the item’s ' +
  'dependency edges in both directions, each entry `{ key, title, status }` with ' +
  '`key` the `PROD-<n>` identifier. Both arrays are always present (empty when the ' +
  'item has no edges in that direction).';

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
