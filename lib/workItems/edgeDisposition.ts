// ── WHAT THE ROADMAP DRAWS FOR AN OFF-LEVEL `blocked_by` ───────────────────────
// (Story MOTIR-6352 · MOTIR-6359; design `design/roadmap/design-notes.md`
// § "Covered cross-parent edges (MOTIR-6015)", MOTIR-6353.)
//
// A canvas level draws one parent's children, so an edge whose blocker sits under
// ANOTHER parent has no node to point at. What it draws instead follows the
// validators' verdict on that edge, and this is the one place the verdict is
// turned into a drawing decision:
//
//  - `cross_level` — the two ends sit on different levels (`isCrossLevelEdge`).
//    INVALID whatever the parents carry (MOTIR-6509): flagged "blocked elsewhere".
//  - `uncovered`   — same level, different parents, and the blocked item's parent
//    is NOT directly `blocked_by` the blocker's parent (`coveredByParents`).
//    INVALID (`invalidEdges`): flagged.
//  - `covered`     — same level, different parents, and the parents DO carry the
//    edge. VALID, and the parents' own arrow one level up already draws it, so
//    this level draws nothing.
//  - `exempt`      — same level, and an end has no work-item parent (a root, or an
//    item FILED in a folder) or both share one. VALID, but no level above draws
//    it, so the canvas keeps a NEUTRAL anchor rather than lose the dependency.
//
// ⚠️ It asks the validators' OWN two predicates and defines neither, so the canvas
// flag and the verdict cannot disagree (`crossParentCoverage.ts` is the one home of
// coverage, `edgeLevel.ts` of the level rule). PURE: the caller resolves each end's
// parent, kind and ancestor chain and the parent-level edges, in batched reads, and
// hands them in — the committed roadmap over the tree, the plan review over the
// projected tree.

import {
  coveredByParents,
  type CoverageEdge,
  type CoverageNodeInfo,
} from '@/lib/workItems/crossParentCoverage';
import { isCrossLevelEdge } from '@/lib/workItems/edgeLevel';

/** How the canvas treats one off-level edge. See the file header. */
export type EdgeDisposition = 'covered' | 'exempt' | 'uncovered' | 'cross_level';

/** Whether a disposition is one the validators call INVALID — the flagged pair. */
export function isFlaggedDisposition(d: EdgeDisposition): boolean {
  return d === 'uncovered' || d === 'cross_level';
}

/**
 * The disposition of `edge`, or `undefined` when an end cannot be described (a
 * cross-project blocker the caller could not place) — the caller then keeps its
 * pre-existing behaviour, which is the permissive answer.
 */
export function edgeDisposition(
  edge: CoverageEdge,
  info: (id: string) => CoverageNodeInfo | undefined,
  parentBlockedBy: (blockedParentId: string, blockerParentId: string) => boolean,
): EdgeDisposition | undefined {
  const blocked = info(edge.blockedId);
  const blocker = info(edge.blockerId);
  if (!blocked || !blocker) return undefined;
  // FIRST: a cross-level edge is invalid whatever its parents carry, and
  // `coveredByParents` does not read the level at all.
  if (isCrossLevelEdge(blocked, blocker)) return 'cross_level';
  if (
    blocked.parentId === null ||
    blocker.parentId === null ||
    blocked.parentId === blocker.parentId
  ) {
    return 'exempt';
  }
  return coveredByParents(edge, (id) => info(id)?.parentId, parentBlockedBy)
    ? 'covered'
    : 'uncovered';
}
