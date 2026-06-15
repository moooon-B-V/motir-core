import type { StatusCategory } from '@prisma/client';
import { keyForAppend } from '@/lib/workItems/positioning';

// The v1 default per-project workflow (Story 2.2 · Subtask 2.2.2) — the typed
// constant `workflowsService.seedDefaultWorkflow` writes into every new
// project. Six statuses spanning the full lifecycle, including a non-terminal
// `blocked` and a terminal `cancelled` (the two most common admin-added
// statuses in real Jira/Linear installs) so every project exercises the
// multi-terminal-status + non-linear-graph paths from day one — not only after
// admin customization.
//
// `position` is the SAME opaque fractional-index sort key `work_item.position`
// uses (finding #43): allocated here via `keyForAppend` (the Story-1.4 helper),
// NOT numeric literals. The statuses sort in declared order; a later reorder is
// a single-row write.

export interface DefaultStatusSpec {
  key: string;
  label: string;
  category: StatusCategory;
  isInitial: boolean;
  position: string;
}

// Declared in display order; `position` is filled below via the
// fractional-index helper so the order is encoded as sortable keys.
const STATUS_ORDER: ReadonlyArray<Omit<DefaultStatusSpec, 'position'>> = [
  { key: 'todo', label: 'To Do', category: 'todo', isInitial: true },
  // Non-terminal "can't proceed, full stop" — complements 1.4.3's
  // work_item_link.is_blocked_by (a link names a specific blocker; this status
  // captures "blocked" including external blockers).
  { key: 'blocked', label: 'Blocked', category: 'todo', isInitial: false },
  { key: 'in_progress', label: 'In Progress', category: 'in_progress', isInitial: false },
  { key: 'in_review', label: 'In Review', category: 'in_progress', isInitial: false },
  { key: 'done', label: 'Done', category: 'done', isInitial: false },
  // Terminal "won't do / duplicate / out-of-scope"; counted as resolved by
  // finding #21's readiness predicate via category = 'done'.
  { key: 'cancelled', label: 'Cancelled', category: 'done', isInitial: false },
];

export const DEFAULT_STATUSES: ReadonlyArray<DefaultStatusSpec> = (() => {
  let prev: string | null = null;
  return STATUS_ORDER.map((s) => {
    prev = keyForAppend(prev);
    return { ...s, position: prev };
  });
})();

/**
 * The keys of the six default statuses (Subtask 2.2.10). A status whose `key`
 * is in here is a PROTECTED default: it can be recolored but NOT renamed,
 * recategorized, reordered, or deleted (finding #49). Used by the service gates
 * and by the editor UI to render the "Default" badge + lock the affordances.
 */
export const DEFAULT_STATUS_KEYS: ReadonlySet<string> = new Set(STATUS_ORDER.map((s) => s.key));

// The default transition graph (restricted-mode), as [fromKey, toKey] pairs.
//
// NOTE ON COUNT (finding #45): the 2.2.2 card enumerated FIFTEEN distinct,
// individually-justified edges but its running total + the "13-transition"
// label undercounted by exactly the two Reopen edges (done→in_progress,
// cancelled→todo) — an arithmetic slip in the card. Every listed edge is
// justified in the card's prose (reopen explicitly: "cancellation is reversible
// …"), and dropping two justified edges to hit 13 has no basis. So the seed
// ships the full enumerated graph. (Decision-authority ladder: a
// self-contradicting card resolved to its substantive enumeration, not its
// mistaken tally.) Subtask 7.8.11 adds ONE more edge — `in_review → blocked`,
// so an item integrated-awaiting-review can stall on a blocker like any other
// active state — bringing the total to SIXTEEN. (The matching backfill
// migration adds this one edge to every EXISTING default-workflow project; the
// rest of the `in_review` graph already shipped in this constant from 2.2.2, so
// only this edge needs backfilling.)
export const DEFAULT_TRANSITIONS: ReadonlyArray<readonly [string, string]> = [
  // Forward main path
  ['todo', 'in_progress'],
  ['in_progress', 'in_review'],
  ['in_review', 'done'],
  // Block / unblock (block from any active state; unblock to either). `in_review`
  // can be blocked too (7.8.11) — review can stall on an external dependency.
  ['todo', 'blocked'],
  ['in_progress', 'blocked'],
  ['in_review', 'blocked'],
  ['blocked', 'todo'],
  ['blocked', 'in_progress'],
  // Backward / rework
  ['in_review', 'in_progress'],
  ['in_progress', 'todo'],
  // Reopen (a closed/cancelled item can come back)
  ['done', 'in_progress'],
  ['cancelled', 'todo'],
  // Cancellation (any non-terminal state can cancel)
  ['todo', 'cancelled'],
  ['in_progress', 'cancelled'],
  ['in_review', 'cancelled'],
  ['blocked', 'cancelled'],
];
