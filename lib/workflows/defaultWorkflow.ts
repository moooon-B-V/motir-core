import type { StatusCategory } from '@/generated/prisma/client';
import { keyForAppend } from '@/lib/workItems/positioning';

// The v1 default per-project workflow (Story 2.2 · Subtask 2.2.2) — the typed
// constant `workflowsService.seedDefaultWorkflow` writes into every new
// project. Eight statuses spanning the full lifecycle, including a non-terminal
// `blocked` and a terminal `cancelled` (the two most common admin-added
// statuses in real Jira/Linear installs) so every project exercises the
// multi-terminal-status + non-linear-graph paths from day one — not only after
// admin customization.
//
// MOTIR-2425 added the seventh, `planning`. Read its note beside the row below
// before assuming it is decoration: its CATEGORY is what stops an unattended run
// re-dispatching a card whose plan is being reconsidered, and `blocked` cannot
// do that job.
//
// MOTIR-3003 added the eighth, `implemented`, for the same structural reason one
// rung further along the loop: an agent's process exiting 0 proves only that the
// process ended, so the card it just pushed must NOT claim a human should look at
// it until CI says the build is green. Its note beside the row below carries the
// reasoning, and where it sits in the order was decided by measurement — see
// `design/boards/design-notes.md` ("Implemented — the eighth board column").
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
  // ⚠️ THE CATEGORY IS THE MECHANISM HERE TOO (MOTIR-3003), for the reason the
  // `planning` note below states in full: readiness is derived from the
  // `is_blocked_by` EDGES and never from the status, so what actually takes a
  // card out of the pickable set is its CATEGORY. A card whose pull request is
  // open and whose checks are still running must not be handed to the next run,
  // and `in_progress` is where it would stay if this status were anywhere else.
  //
  // It is also the honest word. Between "the agent stopped" and "a human should
  // look at this" there is a real state that Motir could not express: the branch
  // is pushed, the pull request is open, and NOTHING has been compiled, linted or
  // tested. In Review is a promise to a person; `implemented` is the fact.
  //
  // ⚠️ ORDER: immediately after `in_progress`, BEFORE `planning`, and that is a
  // MEASURED decision rather than a preference (`design/boards/implemented-column.mock.html`,
  // panel 1). A board column is 288px in a 16px-gap row beside a 240px rail, so
  // slot 4 is the last column a laptop shows in full (from 1512px; a 63–223px
  // sliver below that) and slot 5 is off-screen at every laptop width measured.
  // The path every card walks takes the visible slot; `planning` — an exceptional
  // off-ramp with its own review surface — takes the one after it.
  { key: 'implemented', label: 'Implemented', category: 'in_progress', isInitial: false },
  // ⚠️ THE CATEGORY IS THE MECHANISM (MOTIR-2425). When an agent finds a card it
  // cannot implement it submits a re-plan, and the card must stop being handed
  // out until a human has acted on that plan.
  //
  // `blocked` cannot express that. Readiness here is derived from the
  // `is_blocked_by` EDGES, never from the status, so `blocked` is a human
  // annotation with no structural consequence — a card can sit at `blocked` with
  // every blocker done and be perfectly ready, and one on this project currently
  // is (MOTIR-1762). Setting it and walking away is a status that lies and
  // changes nothing; the next run picks the card straight back up.
  //
  // `planning` sits in the **in_progress** category instead, and that is the
  // whole point: a run takes the TO DO category, so a card here leaves the
  // pickable set STRUCTURALLY. Nothing special-cases it and nothing has to
  // remember why. It is also the truthful word — the card is not blocked and not
  // abandoned, it is in progress on the planning axis rather than the
  // implementation one.
  { key: 'planning', label: 'Planning', category: 'in_progress', isInitial: false },
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
 * The keys of the eight default statuses (Subtask 2.2.10). A status whose `key`
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
// only this edge needs backfilling.) MOTIR-1625 adds the SEVENTEENTH —
// `in_progress → done` (see its comment on the forward path below), again with
// a matching backfill migration for existing default-workflow projects.
// MOTIR-2425 adds `planning` and FIVE more edges (two in, three out), bringing
// the total to TWENTY-TWO — with a backfill that adds the status, its edges and
// a board column to every existing default-workflow project. MOTIR-3003 adds
// `implemented` and SEVEN more (two in, five out), bringing the total to
// TWENTY-NINE — again with a backfill of the status, its edges and a board
// column. Each of the seven is justified beside it below; the tally is amended
// here rather than left stale, which is the convention this comment exists for.
export const DEFAULT_TRANSITIONS: ReadonlyArray<readonly [string, string]> = [
  // Forward main path
  ['todo', 'in_progress'],
  ['in_progress', 'in_review'],
  ['in_review', 'done'],
  // Review is OPTIONAL, not mandatory (MOTIR-1625). Both
  // `in_progress → in_review → done` and `in_progress → done` are legal, for two
  // reasons: (1) a project with no review gate should be able to finish work
  // without parking it in a review column it doesn't use (the Epic-9 configurable
  // review step); (2) the MOTIR-1615 upward rollup moves a parent to `done` once
  // every child is done — and that parent is usually `in_progress`, never
  // `in_review`, so without this edge the done rung would be an illegal move and
  // the rollup would log a no-op and strand the parent.
  ['in_progress', 'done'],
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
  // ── Re-planning (MOTIR-2425) ───────────────────────────────────────────────
  // IN from the two states a card can be in when its plan turns out to be
  // wrong. `in_progress` is the agent's path — it claims a card, starts work,
  // discovers the card is not implementable, and submits a re-plan. `todo` is
  // the human's — noticing before anyone starts.
  //
  // ⚠️ NOT from `in_review`: a card in review whose plan is wrong goes back
  // through `in_review → in_progress` first, which already exists. Adding a
  // second path to the same place would be an edge nobody could justify from a
  // user story, and this graph is enumerated rather than generated.
  ['todo', 'planning'],
  ['in_progress', 'planning'],
  // OUT — three, because approving a plan does not decide what happens to the
  // card that provoked it. A plan may correct this card, split it, or replace
  // it, and only the human who approves knows which:
  //   • `todo`        — the card was corrected and belongs back in the queue.
  //   • `in_progress` — the human decided to just do it.
  //   • `cancelled`   — the plan replaces it.
  //
  // ⚠️ A HUMAN MOVES IT, and plan approval deliberately does NOT. Auto-returning
  // the card to `todo` on approval would put it back in the pickable set before
  // anyone corrected it, and the run would re-dispatch the same defective card —
  // the exact loop this status exists to break.
  ['planning', 'todo'],
  ['planning', 'in_progress'],
  ['planning', 'cancelled'],
  // ── Implemented (MOTIR-3003) ───────────────────────────────────────────────
  // IN, two:
  //   • `in_progress → implemented` — the forward path a run takes when its agent
  //     finishes and its pull request is open.
  //   • `blocked → implemented`     — the inverse of the block edge below, so a
  //     card that stalled while its checks were pending can come back.
  ['in_progress', 'implemented'],
  ['blocked', 'implemented'],
  // OUT, five:
  //   • `implemented → in_review`   — what CI GREEN does, server-side, from the
  //     shared CI-feedback consumer. This is the edge the whole story is for.
  //   • `implemented → in_progress` — rework: the reviewer or the author reopens
  //     it (a red build, or a change of mind before review starts).
  //   • `implemented → blocked`     — an open pull request can still stall on
  //     something external, exactly as `in_review` can (7.8.11's reasoning).
  //   • `implemented → cancelled`   — cancellation is legal from any
  //     non-terminal state; this one is no different.
  //   • `implemented → done`        — a project with no review gate closes
  //     straight from here, the same latitude MOTIR-1625 gave `in_progress`, and
  //     for the same second reason: the MOTIR-1615 rollup moves a parent to
  //     `done` from wherever it is, and without this edge a parent sitting at
  //     `implemented` would strand.
  ['implemented', 'in_review'],
  ['implemented', 'in_progress'],
  ['implemented', 'blocked'],
  ['implemented', 'cancelled'],
  ['implemented', 'done'],
];
