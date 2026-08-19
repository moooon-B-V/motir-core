import { PlanItemNode } from '@/components/planning/PlanItemNode';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// One LEVEL of the plan-detail canvas (MOTIR-3083, redrawing 7.4.5 / MOTIR-847).
//
// ── What changed, and why ───────────────────────────────────────────────────
// This module used to build a forest from the plan's PlanItems ALONE, which the
// consumer then sliced per level. That made the canvas show the proposals and
// nothing else, with two consequences: a proposal parented under a COMMITTED
// item drew at the top level looking exactly like a genuine root (`isRoot` is
// true both for "no parent" and for "a parent outside the rendered set" — right
// for a partial subtree, wrong here), and a reviewer could not see what the new
// card would live beside.
//
// The plan detail is now the ROADMAP, drilled to the level a proposal lands in
// (`design/ai-planning/design-notes.md` Part V; the model is `design/roadmap`'s
// MULTI-LEVEL CHAINS — DRILL-DOWN). So a level is:
//
//     the focused parent's REAL children  ∪  this plan's proposals at that level
//
// and NOTHING else differs from the roadmap — same engine, same edge language,
// same breadcrumb. Only the proposed card's style differs.
//
// ⚠️ A committed sibling is on the canvas because it is a CHILD of the focused
// parent, never because something depends on it. Do not filter the level by
// dependency: seeing the company a proposed card will keep is most of what "is
// this the right place for it?" means.

/** A canvas level: the nodes at it and the edges between them. */
export interface PlanCanvasLevel {
  nodes: ProjectCanvasNode[];
  deps: ProjectCanvasDep[];
}

/** The plan's proposals that belong at ONE level (`parentId` null = top level). */
export function proposalsAtLevel(
  items: PlanReviewItemDto[],
  parentId: string | null,
): PlanReviewItemDto[] {
  return items.filter((i) => (i.parentNodeId ?? null) === parentId);
}

/**
 * Merge this plan's proposals into the COMMITTED level the roadmap read returned.
 *
 * `add` gets an extra node at the level. `modify` / `remove` reuse the SAME node
 * id as their target, so the op treatment lands on the committed sibling already
 * there rather than drawing a ghost copy beside it.
 */
export function mergePlanLevel(
  committed: PlanCanvasLevel,
  items: PlanReviewItemDto[],
  parentId: string | null,
  onEditAdd?: (planItemId: string) => void,
): PlanCanvasLevel {
  const atLevel = proposalsAtLevel(items, parentId);
  const pending = new Map(atLevel.map((i) => [i.nodeId, i]));

  // The committed children, in the order the read gave them, with a `modify` /
  // `remove` re-skinned in place.
  const nodes: ProjectCanvasNode[] = committed.nodes.map((node) => {
    const proposal = pending.get(node.id);
    if (!proposal) return node;
    pending.delete(node.id);
    return { ...node, content: <PlanItemNode item={proposal} onEdit={onEditAdd} /> };
  });

  // Whatever is left is proposed and has no committed node yet: every `add`, plus
  // a `modify` / `remove` whose target is not at this level (a drifted plan).
  for (const item of atLevel) {
    if (!pending.has(item.nodeId)) continue;
    nodes.push({
      id: item.nodeId,
      parentId: item.parentNodeId,
      searchText: `${item.identifier ?? ''} ${item.title}`.trim(),
      crumbLabel: item.identifier ?? item.title,
      drillable: item.hasChildren,
      content: <PlanItemNode item={item} onEdit={onEditAdd} />,
    });
  }

  // The committed edges are kept verbatim; a proposal's own `blocked_by` edges are
  // added when BOTH ends are at this level. Proposed edges are `pending` (not yet
  // firm) — the canvas upgrades one to `cross` when the ends sit under different
  // parents, which is its own bad-plan signal and not this module's business.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const deps: ProjectCanvasDep[] = [...committed.deps];
  const seen = new Set(deps.map((d) => `${d.from} ${d.to}`));
  for (const item of atLevel) {
    for (const blockerId of item.blockedByNodeIds) {
      if (blockerId === item.nodeId) continue;
      if (!nodeIds.has(blockerId) || !nodeIds.has(item.nodeId)) continue;
      const key = `${blockerId} ${item.nodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({ from: blockerId, to: item.nodeId, variant: 'pending' });
    }
  }

  return { nodes, deps };
}
