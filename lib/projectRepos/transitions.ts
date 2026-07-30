import type { ProjectRepoState } from '@prisma/client';

// The per-row establish state machine (Story MOTIR-1775 · MOTIR-1780), exactly as
// `docs/decisions/project-repository-set.md` §4.1 draws it:
//
//   proposed ──create──▶ creating ──▶ created
//      │                    │
//      │                    └──error──▶ failed ──retry──▶ creating
//      │                                   │
//      ├──connect-existing──▶ connected ◀──┘
//      │                                   │
//      └──skip──▶ skipped ◀────────────────┘
//
// Kept PURE and in its own module (no Prisma client, no DB) so the legality rule
// is unit-testable without a row, and so there is exactly ONE place a legal edge
// is declared — the service asks this table, it does not re-implement the graph.

/**
 * The legal outgoing edges of every state. A state whose list is EMPTY is
 * SETTLED: `created`, `connected` and `skipped` are the ADR's settled states, and
 * `failed` is deliberately NOT one — it is resumable (retry, connect-existing, or
 * skip) at any later visit to the establish step.
 *
 * `Record<ProjectRepoState, …>` makes this TOTAL: adding a state to the Prisma
 * enum without declaring its edges is a compile error, not a silently
 * unreachable state.
 *
 * ⚠️ A SETTLED state has no outgoing edge ON PURPOSE, and widening this table is
 * an ADR change, not a code change. Changing one's mind about a settled row is
 * done by REMOVING the row and adding a fresh one (the set is editable —
 * `projectRepoSetService.removeRow`), which keeps "this repo was created" from
 * being quietly overwritten by "actually, skip it". If a later card genuinely
 * needs an un-skip edge, amend ADR §4.1 first so the machine and the record of
 * the decision never disagree.
 */
export const PROJECT_REPO_TRANSITIONS: Record<ProjectRepoState, readonly ProjectRepoState[]> = {
  // Nothing created yet: start creating, connect an existing repo instead, or skip.
  proposed: ['creating', 'connected', 'skipped'],
  // Creation is in flight: it either lands or it errors.
  creating: ['created', 'failed'],
  // Settled — Motir created the repository.
  created: [],
  // Settled — an existing repository was connected (how a monorepo collapses the set).
  connected: [],
  // Settled — deliberately without a repository, which is not an error (ADR §4.3).
  skipped: [],
  // RESUMABLE, not terminal: retry the creation, connect an existing repo, or skip.
  failed: ['creating', 'connected', 'skipped'],
};

/** Whether `from → to` is a legal edge of the ADR §4.1 machine. */
export function canTransition(from: ProjectRepoState, to: ProjectRepoState): boolean {
  return PROJECT_REPO_TRANSITIONS[from].includes(to);
}

/** The legal targets from `from` — what a rejection error names, so a caller can
 *  self-correct instead of guessing. */
export function allowedTransitions(from: ProjectRepoState): readonly ProjectRepoState[] {
  return PROJECT_REPO_TRANSITIONS[from];
}

/** Whether `state` is SETTLED — it has no outgoing edge. */
export function isSettledState(state: ProjectRepoState): boolean {
  return PROJECT_REPO_TRANSITIONS[state].length === 0;
}
