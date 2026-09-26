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
// AMENDMENT 1 (2026-09-26, the user): AN EPIC IS BLOCKED ONLY BY ANOTHER EPIC.
// The epic tier is decided by KIND, ahead of any depth: an edge with an epic at
// either end is legal exactly when both ends are epics. The project root is not a
// common ancestor that makes an epic the peer of a root task, bug or story — both
// sit one step below it, and the position rule alone would join them. Under an
// epic, the position rule stands unchanged.
//
// AMENDMENT 2 (2026-09-26, the user; MOTIR-6509): THE RULE IS A VERDICT ON A
// COMMITTED EDGE AND A REFUSAL ONLY AT THE PLAN GATE. A dependency is a fact
// about the work, so the link doors WRITE a cross-level `blocked_by` — it holds
// the card out of the ready set like any edge — and `validate_work_item` reports
// it INVALID ("blocked elsewhere", `crossLevelEdges`). The planner still may not
// author one: the plan gate refuses it (`INVALID_PLAN_REF_GRAPH` / `cross_level`).
//
// THE ONE HOME of the rule. The plan gate (over the PROJECTED chains), the
// validators' `crossLevelEdges` verdict (over committed or projected chains) and
// the cross-parent coverage walk (`crossParentCoverage.ts`) all call
// {@link isCrossLevelEdge}, so they cannot disagree about which edges are legal.

import type { CrossLevelEdgeDto } from '@/lib/dto/workItems';

/** One end of a `blocked_by`, as the rule reads it. */
export interface EdgeEnd {
  /** The item's work-item kind — decides the EPIC tier (Amendment 1). */
  kind: string;
  /**
   * The item's ANCESTOR CHAIN — its work-item ancestors, NEAREST FIRST (parent,
   * grandparent, …), empty for a root or a filed item — the shape
   * `workItemRepository.findAncestorIdsForItems` returns.
   */
  ancestors: readonly string[];
}

/** The epic tier's reason, for the copy — the gate and the verdict word it from here. */
const EPIC_TIER = 'An epic is blocked only by another epic';

/**
 * True when a `blocked_by` between the two items would join two different
 * levels.
 *
 * An EPIC at either end first: the edge is legal exactly when both ends are
 * epics (Amendment 1). Otherwise walk both chains up to their nearest common
 * ancestor (the shared tail of the two chains, or the project root when they
 * share none): the edge is same-level exactly when both walks take the same
 * number of steps.
 */
export function isCrossLevelEdge(a: EdgeEnd, b: EdgeEnd): boolean {
  if (a.kind === 'epic' || b.kind === 'epic') return a.kind !== b.kind;
  let shared = 0;
  while (
    shared < a.ancestors.length &&
    shared < b.ancestors.length &&
    a.ancestors[a.ancestors.length - 1 - shared] === b.ancestors[b.ancestors.length - 1 - shared]
  ) {
    shared += 1;
  }
  return a.ancestors.length - shared !== b.ancestors.length - shared;
}

/**
 * The sentence that explains why `blocked` → `blocker` crosses levels, each named
 * by the caller's own label. One wording for the plan gate's refusal and the
 * validators' verdict.
 */
export function crossLevelReason(
  blocked: EdgeEnd & { label: string },
  blocker: EdgeEnd & { label: string },
): string {
  if (blocked.kind === 'epic' || blocker.kind === 'epic') {
    return (
      `${blocked.label} is ${article(blocked.kind)} and ${blocker.label} is ` +
      `${article(blocker.kind)}. ${EPIC_TIER}; under an epic, a blocked_by joins two work ` +
      `items at the SAME depth below their nearest common ancestor.`
    );
  }
  return (
    `${blocked.label} sits ${blocked.ancestors.length} level(s) below the project root and ` +
    `${blocker.label} sits ${blocker.ancestors.length}, so they are not on the same level. A ` +
    `blocked_by joins two work items at the SAME depth below their nearest common ancestor (a ` +
    `folder adds no depth). It may cross parents; it may not cross levels. ${EPIC_TIER}.`
  );
}

function article(kind: string): string {
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
}

/** One end of a `blocked_by` the verdict names: its position, kind and label. */
export interface LabelledEdgeEnd extends EdgeEnd {
  /** The identifier the finding names this end by (`MOTIR-7`, or a temp-ref). */
  label: string;
}

/**
 * The CROSS-LEVEL `blocked_by` edges among `edges` — the verdict both validators
 * report as `crossLevelEdges` (MOTIR-6509, Amendment 2): the item, its blocker,
 * both depths below the project root and the sentence that explains it. An edge
 * with an end the caller cannot place (`end` answers `undefined`) is not judged.
 * Sorted by item, then blocker, for a stable wire shape.
 */
export function crossLevelEdgeFindings(
  edges: ReadonlyArray<{ blockedId: string; blockerId: string }>,
  end: (id: string) => LabelledEdgeEnd | undefined,
): CrossLevelEdgeDto[] {
  const out: CrossLevelEdgeDto[] = [];
  for (const edge of edges) {
    const blocked = end(edge.blockedId);
    const blocker = end(edge.blockerId);
    if (!blocked || !blocker || !isCrossLevelEdge(blocked, blocker)) continue;
    out.push({
      item: blocked.label,
      blockedBy: blocker.label,
      itemDepth: blocked.ancestors.length,
      blockedByDepth: blocker.ancestors.length,
      reason: 'blocked_elsewhere',
      explanation: crossLevelReason(blocked, blocker),
    });
  }
  return out.sort((a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy));
}
