import { PlanItemNode, type PlanItemOutcome } from '@/components/planning/PlanItemNode';
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
  /**
   * The plan's DECISION, once it has one (MOTIR-3161) — drawn on every node the
   * plan contributes, and on none of the committed neighbours, which the plan
   * decided nothing about. `null` while the plan is still `planned`, which is
   * every level that rendered before this.
   */
  outcome: PlanItemOutcome | null = null,
): PlanCanvasLevel {
  const atLevel = proposalsAtLevel(items, parentId);
  const pending = new Map(atLevel.map((i) => [i.nodeId, i]));

  // The committed children, in the order the read gave them, with a `modify` /
  // `remove` re-skinned in place.
  const nodes: ProjectCanvasNode[] = committed.nodes.map((node) => {
    const proposal = pending.get(node.id);
    if (!proposal) return node;
    pending.delete(node.id);
    return { ...node, content: <PlanItemNode item={proposal} outcome={outcome} /> };
  });

  // Whatever is left is proposed and has no committed node yet: every `add`, plus
  // a `modify` / `remove` whose target is not at this level (a drifted plan).
  //
  // ⚠️ `viewable` is what SURFACES the View button — `ProjectRoadmapCanvas`
  // renders the pill only for a node carrying the flag. MOTIR-3084 built the
  // proposal peek (`ProposalQuickView`) and wired `onView` for every op, but the
  // node it opens from was pushed without the flag, so the door existed and
  // nothing opened it: selecting a proposed card offered no affordance at all.
  // A committed node gets the same flag from `buildWorkItemLevel`; this is the
  // proposed half of the same contract, and it holds for every op — an `add`
  // peeks its proposal, a `modify` / `remove` peeks the live target it names.
  for (const item of atLevel) {
    if (!pending.has(item.nodeId)) continue;
    nodes.push({
      id: item.nodeId,
      parentId: item.parentNodeId,
      searchText: `${item.identifier ?? ''} ${item.title}`.trim(),
      crumbLabel: item.identifier ?? item.title,
      drillable: item.hasChildren,
      viewable: true,
      content: <PlanItemNode item={item} outcome={outcome} />,
    });
  }

  // The committed edges are kept verbatim EXCEPT the ones the plan DELETES; a
  // proposal's own `blocked_by` edges are added when BOTH ends are at this level.
  // Proposed edges are `pending` (not yet firm) — the canvas upgrades one to
  // `cross` when the ends sit under different parents, which is its own bad-plan
  // signal and not this module's business.
  const nodeIds = new Set(nodes.map((n) => n.id));
  // ⚠️ AN EDGE THE PLAN DELETES IS DROPPED, NOT DRAWN (bug MOTIR-4092, whose
  // first fix drew it, reversed by bug MOTIR-4098).
  //
  // `blockedByRemovedNodeIds` is the removal carrier the review model resolves
  // separately — separately, because an edge the plan deletes is not a blocker
  // the proposal declares and must never be drawn as one. Here is where the two
  // meet: a committed dep whose (from, to) pair a proposal at this level names
  // for removal does not reach the canvas at all.
  //
  // DROPPED, NOT RE-SKINNED — MOTIR-4098 REVERSES the first fix, which kept the
  // edge and marked it as going away. Whatever it is skinned like, a
  // drawn edge is still an ARROW between two cards, and the canvas is read for
  // its SHAPE: what blocks what, in what order. A shape carrying lines the reader
  // has to decode as *ignore me* is the confusing picture the marking was meant
  // to fix. The removal is not silenced by dropping it — `buildChanges`' `links`
  // row still reports `+N / −N blockers` in words, which is where a diff belongs.
  // The graph draws what approving would LEAVE BEHIND.
  const removedPairs = new Set<string>();
  for (const item of atLevel) {
    for (const blockerId of item.blockedByRemovedNodeIds) {
      removedPairs.add(`${blockerId} ${item.nodeId}`);
    }
  }
  const deps: ProjectCanvasDep[] = committed.deps.filter(
    (dep) => !removedPairs.has(`${dep.from} ${dep.to}`),
  );
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
