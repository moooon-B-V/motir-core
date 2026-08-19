// The BLOCKER-READINESS predicate — one rule, one home (MOTIR-3050).
//
// "Is this item's dependency set satisfied?" is answered in exactly one place,
// and it is this file. It used to live inside `workItemsService` because the two
// readiness reads (`getReadiness` single, `getReadinessForItems` batch) were its
// only callers. `plansService.materialize` is now a third: an approved plan's
// `add` is BORN `blocked` when its resolved edges say it cannot start, and that
// verdict has to be the SAME verdict the ready set will reach a moment later —
// not a second, similar-looking one written beside it. Hoisting the classifier
// to a leaf module is what makes that structural rather than a coincidence
// (and it keeps `plansService` from importing a 5 000-line service for one pure
// function).
//
// PURE — no I/O, no Prisma, no context. The callers do the reads and hand the
// rows in.

/** A blocker row as the readiness classifier needs it — its status + project
 *  (for the per-project terminal check) and its integration `sessionBranch`. */
export interface BlockerReadinessState {
  status: string;
  projectId: string;
  sessionBranch: string | null;
}

/** Whether a single blocker is still OPEN — neither terminal (status in its
 *  project's `category=done` set) nor integrated-awaiting-review (a recorded
 *  `sessionBranch`). The shared open-predicate `getReadiness` reuses to name the
 *  open blocker ids and `classifyBlockerReadiness` reuses to decide readiness. */
export function isOpenBlocker(
  blocker: BlockerReadinessState,
  terminalByProject: Map<string, Set<string>>,
): boolean {
  const terminal = terminalByProject.get(blocker.projectId)?.has(blocker.status) ?? false;
  return !terminal && !blocker.sessionBranch;
}

/**
 * Classify a work item's blockers under the integrated-dep readiness rule
 * (Subtask 7.8.11). A blocker is SATISFIED when it is TERMINAL (status in its
 * project's `category=done` set) OR INTEGRATED-awaiting-review (a recorded
 * `sessionBranch`); otherwise it is OPEN. Every integrated blocker contributes
 * its branch to the item's lineage set: an item whose integrated deps span MORE
 * THAN ONE session branch has CONFLICTING lineages and is NOT ready (a human
 * must merge one session PR first). The single shared lineage (when exactly one)
 * is what the dispatch payload inherits. A terminal blocker's branch is IGNORED
 * (reaching done clears it; ignoring it keeps the rule correct even if that
 * invariant were ever violated). PURE — the single source of the rule, reused by
 * `getReadiness` (single), `getReadinessForItems` (batch) and
 * `plansService.materialize` (the birth status of an approved plan's `add`).
 */
export function classifyBlockerReadiness(
  blockers: BlockerReadinessState[],
  terminalByProject: Map<string, Set<string>>,
): {
  ready: boolean;
  sessionBranches: string[];
  inheritedSessionBranch: string | null;
  conflicting: boolean;
} {
  let hasOpenBlocker = false;
  const branches = new Set<string>();
  for (const b of blockers) {
    const terminal = terminalByProject.get(b.projectId)?.has(b.status) ?? false;
    if (terminal) continue; // satisfied; a done blocker contributes no lineage
    if (b.sessionBranch) {
      branches.add(b.sessionBranch); // integrated — satisfied, carries its lineage
      continue;
    }
    hasOpenBlocker = true; // truly open
  }
  const sessionBranches = [...branches].sort();
  const conflicting = sessionBranches.length > 1;
  const inheritedSessionBranch = sessionBranches.length === 1 ? sessionBranches[0]! : null;
  return {
    ready: !hasOpenBlocker && !conflicting,
    sessionBranches,
    inheritedSessionBranch,
    conflicting,
  };
}
