import { PlanItemNode } from '@/components/planning/PlanItemNode';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// Turn a plan's proposed items (the MOTIR-847 review model) into the reusable
// canvas's nodes + deps (Subtask 7.4.5 — "MOUNT `WorkItemCanvas` (1194) fed the
// PlanItems as data; do NOT redraw a canvas", #82). Each PlanItem → a
// `PlanItemNode` drawn by its `op` (add / modify / remove). The canvas owns the
// box, position, drill, zoom; this owns the look. Pure (no fetching, no DOM
// effects) so it is unit-testable; the consumer (`PlanReviewCanvas`) slices it
// PER LEVEL for the drill-down render (#91 — one level on screen, never the whole
// forest at once).

export function buildPlanForest(
  items: PlanReviewItemDto[],
  // Open the inline-edit form for a proposed `add` (7.21.6 · MOTIR-1370). Threaded
  // into each node's pre-rendered content so an `add` node shows its Edit trigger.
  onEditAdd?: (planItemId: string) => void,
): {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
} {
  const nodeIds = new Set(items.map((i) => i.nodeId));

  const nodes: ProjectCanvasNode[] = items.map((item) => ({
    id: item.nodeId,
    parentId: item.parentNodeId,
    searchText: `${item.identifier ?? ''} ${item.title}`.trim(),
    crumbLabel: item.identifier ?? item.title,
    drillable: item.hasChildren,
    content: <PlanItemNode item={item} onEdit={onEditAdd} />,
  }));

  const deps: ProjectCanvasDep[] = [];
  for (const item of items) {
    for (const blockerId of item.blockedByNodeIds) {
      // Only draw an edge when BOTH ends are nodes in the proposed forest; a
      // blocker that is an unchanged existing item (not in the plan) has no node
      // here, so its edge is dropped (the canvas shows one proposed forest, not
      // the whole committed tree).
      if (!nodeIds.has(blockerId) || blockerId === item.nodeId) continue;
      // Proposed edges are `pending` (not-yet-firm); the canvas OVERRIDES to
      // `cross` when the two ends sit under different parents (the bad-plan flag).
      deps.push({ from: blockerId, to: item.nodeId, variant: 'pending' });
    }
  }

  return { nodes, deps };
}
