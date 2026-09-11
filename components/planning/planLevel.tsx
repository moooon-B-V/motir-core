import { PlanItemNode, type PlanItemOutcome } from '@/components/planning/PlanItemNode';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import { proposedParentNodeIds } from '@/lib/planning/planShape';
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

  // ⚠️ A COMMITTED CARD THE PLAN PUTS WORK UNDER BECOMES DRILLABLE (bug
  // MOTIR-4266). `buildWorkItemLevel` takes `drillable` from the ROADMAP read,
  // which counts COMMITTED children only — so a story with nothing under it yet
  // arrived `drillable: false` however many subtasks this plan proposes beneath
  // it, the canvas drew View and no Open pill, and the expansion the plan is
  // ABOUT was unreachable from the level the story lives on. Expanding an
  // existing story is the commonest thing a planning pass does, and the
  // plan-change canvas has had this rule since MOTIR-1730; the review canvas —
  // the surface the plan is approved from — never got it.
  //
  // The whole plan is read, not `atLevel`: the question is what sits UNDER each
  // node here, which is a level DOWN. Every op counts, because `parentNodeId` is
  // where the proposal SITS, including a `modify` that re-parents a card onto
  // this node (MOTIR-3859).
  const gainsChildren = proposedParentNodeIds(items);

  // ⚠️ A CARD THE PLAN RE-PARENTS AWAY FROM THIS LEVEL IS NOT ON IT (bug
  // MOTIR-5006) — the FOURTH field taken off the level's committed read and never
  // re-asked about a card the plan is moving, and the only one that is not a
  // decoration: it is whether the card is there at all. `planReviewService`'s
  // `parentNodeIdOf` already reports a re-parented card at its DESTINATION, for
  // the stated reason that *"a re-parent that drew the card in its OLD level
  // would be the plan review showing the approver the opposite of what approving
  // does"*. That sentence is about the ORIGIN as much as the destination, and only
  // half of it was ever applied: at the origin the card fell out of `atLevel`, so
  // `pending` had no entry for it, the map below passed it through untouched, and
  // it sat among its siblings with its committed arrows intact.
  //
  // ── THE DISPOSITION, and why this one ──────────────────────────────────────
  // The card is taken OFF the level, and every committed edge between it and a
  // card that STAYS is drawn by the OFF-LEVEL rule — a `cross` arrow to a naming
  // anchor — rather than kept as a within-level arrow or dropped. Three claims,
  // and the third is the one that settles it:
  //
  //  - It is what this function is ALREADY decided by. MOTIR-4098 reversed the
  //    first fix for a REMOVED EDGE and the comment sixty lines down states the
  //    rule it left behind: *"the graph draws what approving would LEAVE
  //    BEHIND."* A node is a stronger claim than an arrow, not a weaker one — a
  //    card drawn on a level says *this container holds this card* — so a
  //    treatment saying *it is leaving* is the same marked-going-away shape that
  //    was tried and reverted, one field up.
  //  - It is what the level ACTUALLY looks like after approve. Re-read level `L`
  //    once the plan lands: the card is not among its children, and the
  //    dependency it left behind is a cross-container blocker with a ghost
  //    anchor. Dropping the card and its edges would under-draw that by one
  //    arrow; keeping the card would over-draw it by one node. Neither is the
  //    level the reviewer gets.
  //  - It answers the under-report the ALTERNATIVE was raised against. The cost
  //    of a bare DROP is MOTIR-4951's — the reviewer loses a card without being
  //    told. They are told: the card is named on its anchor, and the arrow flies
  //    the bad-plan flag, which is the honest verdict about a plan that moves a
  //    blocker out of its dependent's container. Under a *departing* skin that
  //    warning cannot be drawn at all, because the card is still on the level and
  //    the edge is still within it.
  //
  // ── WHERE THE MECHANISM LIVES ──────────────────────────────────────────────
  // NOT HERE, and for exactly MOTIR-4952's reason rather than a new one: two of
  // the three effects are unreachable downstream — the `crossBlocked` ring is
  // baked into the dependent's rendered `content`, and the anchor must be minted
  // before the merge runs. So the consumer answers *which rows is this plan
  // moving off?* (`PlanReviewCanvas`, one pass over the whole `items` array,
  // beside the `arrivingBlockers` map it is the mirror of) and
  // `buildWorkItemLevel`'s `departingIds` takes them off the level with a naming
  // stub. By the time this function runs, `committed` no longer contains the
  // card — which is why the map below needs no departure case, and why a
  // `modify` that does NOT re-parent still re-skins in place exactly as before.
  //
  // That is the shape MOTIR-4952 introduced and this card completes: everything
  // the merge inherits from the committed read is provisional with respect to the
  // cards the plan moves, in BOTH directions, and each direction is now answered
  // at the source rather than patched a field at a time.

  // The committed children, in the order the read gave them, with a `modify` /
  // `remove` re-skinned in place.
  const nodes: ProjectCanvasNode[] = committed.nodes.map((node) => {
    const drillable = node.drillable || gainsChildren.has(node.id);
    const proposal = pending.get(node.id);
    if (!proposal) return drillable === node.drillable ? node : { ...node, drillable };
    pending.delete(node.id);
    return { ...node, drillable, content: <PlanItemNode item={proposal} outcome={outcome} /> };
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

  // ⚠️ A CARD THE PLAN RE-PARENTS ONTO THIS LEVEL BRINGS ITS OWN COMMITTED EDGES
  // (bug MOTIR-4951) — and `committed` cannot supply them, because `committed` is
  // the level's CURRENT children and the moving card is precisely the one that is
  // not among them yet. It is the same COMMITTED-only trap the `drillable`
  // comment forty lines up names for a different field, from the same cause, in
  // this function: the level's committed read is the wrong basis for ANYTHING
  // about a card the plan is moving.
  //
  // So the endpoint half of the card arrives on the proposal, as
  // `committedBlockedBy`. It is not a proposed edge and must not be drawn like
  // one: approving creates nothing here, so each is drawn by the committed rule
  // `buildWorkItemLevel` uses — `firm` once the blocker is `done`, `pending`
  // while it is not — which is exactly how the same edge will be drawn on the
  // level the reviewer gets after approve.
  //
  // BEFORE the proposed loop, so a plan that ALSO proposes an existing edge does
  // not re-draw it `pending` (`seen` is what holds that), and AFTER the removal
  // filter, so `removedPairs` still subtracts one of these: widening the
  // committed set must not resurrect an edge the plan deletes (bugs MOTIR-4092 /
  // MOTIR-4098). Both ends must be on the level, the same rule the proposed loop
  // below applies — an edge to a blocker that stays elsewhere is not drawn.
  for (const item of atLevel) {
    for (const blocker of item.committedBlockedBy) {
      if (blocker.nodeId === item.nodeId) continue;
      if (!nodeIds.has(blocker.nodeId) || !nodeIds.has(item.nodeId)) continue;
      const key = `${blocker.nodeId} ${item.nodeId}`;
      if (seen.has(key) || removedPairs.has(key)) continue;
      seen.add(key);
      deps.push({
        from: blocker.nodeId,
        to: item.nodeId,
        variant: blocker.isDone ? 'firm' : 'pending',
      });
    }
  }

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
