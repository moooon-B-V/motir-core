// ── THE LEVEL A `blocked_by` EDGE JOINS (Story MOTIR-6015 · MOTIR-6367) ────────
//
// A `blocked_by` joins two work items on the SAME LEVEL, wherever each sits in
// the tree — a subtask may wait on a subtask in another story, a story on a
// story in another epic. What it may never do is join two LEVELS: a subtask
// waiting on a whole story, an epic waiting on one subtask.
//
// There are THREE levels, not five kinds. `task`, `bug` and `subtask` are all
// LEAVES — the unit a run executes — so a bug may block a subtask and a subtask
// may block a task. `epic` and `story` are each their own level.
//
// PURE and TOTAL over the five kinds (`IssueType`, identical to the schema's
// `WorkItemKind`): the record below is compiler-checked against it, and an
// unknown string throws rather than defaulting, so a kind added later cannot be
// silently levelled.
// The plan gate (`lib/plans/validateProposals.ts`) and the link door read it, so
// the two cannot disagree about which edges are legal.

import { isIssueType, type IssueType } from '@/lib/issues/parentRules';

/** The three levels an edge may join within. */
export type EdgeLevel = 'epic' | 'story' | 'leaf';

const LEVEL_OF_KIND: Record<IssueType, EdgeLevel> = {
  epic: 'epic',
  story: 'story',
  task: 'leaf',
  bug: 'leaf',
  subtask: 'leaf',
};

/** The level a work item of `kind` sits on. Throws on a kind that is not one. */
export function edgeLevel(kind: string): EdgeLevel {
  if (!isIssueType(kind)) {
    throw new Error(`"${kind}" is not a work-item kind, so it has no edge level.`);
  }
  return LEVEL_OF_KIND[kind];
}

/** True when a `blocked_by` between `a` and `b` would join two different levels. */
export function isCrossLevelEdge(a: string, b: string): boolean {
  return edgeLevel(a) !== edgeLevel(b);
}
