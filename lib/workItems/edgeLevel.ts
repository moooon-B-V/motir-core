// ── THE LEVEL A `blocked_by` EDGE JOINS: POSITION, NOT KIND ────────────────────
// (Story MOTIR-6015 · MOTIR-6367, re-based on the accepted decision MOTIR-6387 by
// MOTIR-6411 — `docs/decisions/edge-level-is-position.md`.)
//
// A `blocked_by` joins two items on the SAME LEVEL, wherever each sits in the
// tree — a subtask may wait on a subtask in another story, a story on a story in
// another epic. What it may never do is join two levels.
//
// An item's level is its POSITION: two items are on the same level when they sit
// at the SAME DEPTH below their nearest common ancestor, where the project root is
// the ancestor of every root item and a FOLDER adds no depth (a folder is a
// placement, so a filed item is a root). No kind table is consulted: a validation
// task under an epic beside its stories is on their level, and a subtask under a
// task can be tied to a subtask under a story. Kind still bounds what can EXIST
// (`lib/issues/parentRules.ts`); it no longer decides an edge.
//
// THE ONE HOME of the rule. The plan gate (over the PROJECTED chains), the link
// door and the `cross-level-edge` advisory (over COMMITTED chains) and the
// cross-parent coverage walk (`crossParentCoverage.ts`) all call
// {@link isCrossLevelEdge}, so they cannot disagree about which edges are legal.

import { CrossLevelLinkError } from '@/lib/workItems/linkErrors';

/**
 * True when a `blocked_by` between the two items would join two different
 * levels. Each argument is the item's ANCESTOR CHAIN — its work-item ancestors,
 * NEAREST FIRST (parent, grandparent, …), empty for a root or a filed item —
 * the shape `workItemRepository.findAncestorIdsForItems` returns.
 *
 * Walk both up to their nearest common ancestor (the shared tail of the two
 * chains, or the project root when they share none): the edge is same-level
 * exactly when both walks take the same number of steps.
 */
export function isCrossLevelEdge(
  ancestorsA: readonly string[],
  ancestorsB: readonly string[],
): boolean {
  let shared = 0;
  while (
    shared < ancestorsA.length &&
    shared < ancestorsB.length &&
    ancestorsA[ancestorsA.length - 1 - shared] === ancestorsB[ancestorsB.length - 1 - shared]
  ) {
    shared += 1;
  }
  return ancestorsA.length - shared !== ancestorsB.length - shared;
}

/**
 * The committed-edge door's use of the rule (MOTIR-6369): refuse a NEW directed
 * `is_blocked_by` between two levels. `from` is the blocked item, `to` its
 * blocker — the stored direction — each with its ancestor chain. Every other
 * link kind passes untouched.
 */
export function assertLinkSameLevel(
  kind: string,
  from: { identifier: string; ancestors: readonly string[] },
  to: { identifier: string; ancestors: readonly string[] },
): void {
  if (kind !== 'is_blocked_by' || !isCrossLevelEdge(from.ancestors, to.ancestors)) return;
  throw new CrossLevelLinkError(
    { key: from.identifier, depth: from.ancestors.length },
    { key: to.identifier, depth: to.ancestors.length },
  );
}
