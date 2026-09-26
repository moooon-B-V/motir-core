// ── A CROSS-PARENT EDGE IS VALID ONLY WHEN THE PARENTS CARRY IT ────────────────
// (Story MOTIR-6015 · MOTIR-6370.)
//
// A `blocked_by` joins two items on the SAME LEVEL (`edgeLevel.ts`) and may cross
// parents: a subtask may wait on the subtask in another story it needs. Such an
// edge is VALID only when the blocked item's parent is itself DIRECTLY
// `blocked_by` the blocker's parent — the tree stays readable one level up. The
// parents' own edge is judged by this same predicate in turn, so a subtask edge
// across epics owes the story edge AND the epic edge: the recursion is carried
// by asking the question of EVERY edge, not by walking upward here.
//
// ⚠️ THE ONE HOME of the predicate. The validators (`validate_work_item`,
// `validate_plan`) call it, and the roadmap's "blocked elsewhere" signal is to
// call it too (MOTIR-6359), so the canvas flag and the validator verdict cannot
// disagree. `tests/workItems/crossParentCoverage.test.ts` pins that nothing else
// defines a second copy.
//
// PURE: the caller resolves parents and the parent-level edges it needs, in one
// batched read, and hands them in.

import { isCrossLevelEdge } from '@/lib/workItems/edgeLevel';

/** One `blocked_by` edge: `blockedId` waits on `blockerId`. */
export interface CoverageEdge {
  blockedId: string;
  blockerId: string;
}

/**
 * True when `edge` needs no parent edge, or its parents carry one.
 *
 * - **Same parent** ⇒ covered: a sibling edge is the ordinary case.
 * - **An end with no work-item parent** — a root, or an item FILED in a folder
 *   (a folder is a placement, not a parent) — ⇒ covered (exempt): there is no
 *   parent edge to require. A cross-project blocker the caller could not place
 *   reads the same way, which is the permissive answer.
 * - **Different parents** ⇒ covered exactly when the blocked end's parent is
 *   DIRECTLY `blocked_by` the blocker end's parent.
 *
 * `parentOf` answers `null` for "no work-item parent" and `undefined` for "not
 * known here"; both exempt. `parentBlockedBy(a, b)` answers whether `a` is
 * directly `blocked_by` `b`.
 */
export function coveredByParents(
  edge: CoverageEdge,
  parentOf: (id: string) => string | null | undefined,
  parentBlockedBy: (blockedParentId: string, blockerParentId: string) => boolean,
): boolean {
  const blockedParent = parentOf(edge.blockedId);
  const blockerParent = parentOf(edge.blockerId);
  if (blockedParent == null || blockerParent == null) return true;
  if (blockedParent === blockerParent) return true;
  return parentBlockedBy(blockedParent, blockerParent);
}

/** What {@link uncoveredCrossParentEdges} needs to know about one end of an edge. */
export interface CoverageNodeInfo {
  /** `null` = no work-item parent (a root, or filed in a folder). */
  parentId: string | null;
  /** The item's ancestor chain, nearest first — its POSITION (MOTIR-6411). */
  ancestors: readonly string[];
  /** The item's kind — an epic pairs only with an epic (Amendment 1). */
  kind: string;
}

/**
 * Every edge in `edges` that is SAME-LEVEL (the same depth below the nearest
 * common ancestor — `edgeLevel.ts`), crosses parents, and is not covered by a
 * parent edge — the `invalidEdges` both validators report. Walking both ends up
 * one parent at a time, each pair of parents met is the edge the rule owes; this
 * asks it of the first pair, and the same question asked of every edge carries it
 * up. A cross-LEVEL edge is skipped: it is its own finding (MOTIR-6509),
 * reported in the validators' `crossLevelEdges`. An end the caller cannot describe is exempt.
 */
export function uncoveredCrossParentEdges(
  edges: readonly CoverageEdge[],
  info: (id: string) => CoverageNodeInfo | undefined,
  parentBlockedBy: (blockedParentId: string, blockerParentId: string) => boolean,
): CoverageEdge[] {
  return edges.filter((edge) => {
    const blocked = info(edge.blockedId);
    const blocker = info(edge.blockerId);
    if (!blocked || !blocker) return false;
    if (isCrossLevelEdge(blocked, blocker)) return false;
    return !coveredByParents(edge, (id) => info(id)?.parentId, parentBlockedBy);
  });
}
