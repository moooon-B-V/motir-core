// THE LANE a re-plan is allowed to be approved in, unattended (MOTIR-4085).
//
// ── Why there is a lane at all ──────────────────────────────────────────────
// `autoLoop.ts`'s `replanned` stop reason explains itself: the loop stops rather
// than picking up other work *"since the cards the loop would take next are the
// ones that plan may be about to change"*. That is a correct rule with a missing
// condition — it is entirely about SCOPE. Bound what the plan may touch, and
// re-read the queue it just changed, and the reason stops applying.
//
// This module is the bound. It is PURE: a function over the plan the loop
// already has in hand, with no client, no clock and no stdout, so every arm is
// unit-testable against a plain object — the same split `autoLoop.ts` keeps
// against `commands/auto.ts`.
//
// ── The bound is the SIBLING LEVEL, and that is not a round number ──────────
// A `subtask` parents nothing (`subtask → []` in the kind matrix), so *"this
// card is wrong, it is really two"* cannot add anything UNDER the card — adding
// a card means adding a SIBLING. So the widest correction that is still about
// THIS card is the card plus the other children of its parent: a rewrite, a
// split into two siblings, an added sibling, a sibling that should not exist.
// Anything wider is a re-plan of the container, and a container re-plan is
// exactly the case a person should see.
//
// ── It runs SECOND, and only on a VALID plan ────────────────────────────────
// Two checks, two jobs. VALIDITY — may this plan become rows at all? — is
// shipped, unconditional and the server's: `validateCandidatePlan` /
// `validateCandidateForest` run on every finished plan, and `approvePlan`
// re-validates the whole proposal set before any write. The lane check has no
// opinion about cycles, the kind matrix, cross-boundary edges or the depth cap,
// and deliberately does not re-implement one. It answers only WHO APPROVES.

/** One proposal, as the plan document carries it — the fields the lane reads. */
export interface LaneProposal {
  op: 'add' | 'modify' | 'remove';
  /** The `MOTIR-<n>` a `modify` / `remove` targets. `null` on an `add`, always:
   *  no work item exists for it until the plan is approved. */
  workItemKey: string | null;
  /** The `MOTIR-<n>` this proposal's `parentRef` names, when it names a
   *  COMMITTED work item — `null` for an intra-plan temp-ref, for a parent the
   *  caller may not browse, and for a proposal naming no parent. */
  parentKey?: string | null;
  /** The raw ref, kept only so a refusal can SAY what it could not resolve. */
  parentRef?: string | null;
}

/** The plan document, narrowed to what the lane reads. */
export interface LanePlan {
  proposals: LaneProposal[];
}

/** The lane, as the loop knows it at the moment it asks. */
export interface Lane {
  /** The card this iteration is working — always a leaf. */
  leafKey: string;
  /** Its parent, or `null` for a top-level card. */
  parentKey: string | null;
  /**
   * The parent's CURRENT children, re-read at this moment rather than
   * remembered. The leaf itself may or may not be in it; membership is tested
   * against the union either way.
   */
  siblingKeys: readonly string[];
}

/** ONE proposal that fell outside the lane, with what it would have touched. */
export interface OutOfLaneProposal {
  op: LaneProposal['op'];
  /** The `MOTIR-<n>` this proposal affects, or a description of why there is
   *  none to name — a reader has to be able to act on this line. */
  affects: string;
  /** Why it is out of lane, in one clause. */
  reason: string;
}

export type LaneVerdict = { ok: true } | { ok: false; outOfLane: OutOfLaneProposal[] };

/**
 * Is every proposal on this plan inside the card's own lane?
 *
 * What each op AFFECTS, and the whole of it:
 *
 * | proposal              | affects                                          |
 * |-----------------------|--------------------------------------------------|
 * | `modify <key>`        | `<key>`                                          |
 * | `remove <key>`        | `<key>`                                          |
 * | `add` with `parentRef`| the PARENT — it is putting a child there         |
 *
 * IN LANE = the leaf, plus the leaf's siblings; and every `add` must land under
 * the leaf's own parent.
 *
 * ⚠️ IT NAMES WHAT FELL OUT, never a bare `false`. *"Not auto-approved — the
 * plan also modifies MOTIR-3942"* is something an operator can act on at
 * breakfast; *"not auto-approved"* is a thing they have to go and investigate.
 * The shape mirrors `validate_plan`'s `{ valid, blockers }`, which is already
 * this codebase's idiom for a verdict plus its reasons.
 *
 * ⚠️ AN UNRESOLVABLE TARGET IS OUT OF LANE, not skipped. A `modify` whose
 * `workItemKey` came back `null` names an item this caller cannot see, and a
 * proposal whose effect cannot be established is precisely the proposal a person
 * should be looking at. Failing open here would make the check silent exactly
 * where it is least able to see.
 */
export function inLane(plan: LanePlan, lane: Lane): LaneVerdict {
  const inSet = new Set<string>([lane.leafKey.toUpperCase()]);
  for (const key of lane.siblingKeys) inSet.add(key.toUpperCase());

  const outOfLane: OutOfLaneProposal[] = [];
  for (const proposal of plan.proposals) {
    const out = classify(proposal, lane, inSet);
    if (out) outOfLane.push(out);
  }
  return outOfLane.length === 0 ? { ok: true } : { ok: false, outOfLane };
}

function classify(
  proposal: LaneProposal,
  lane: Lane,
  inSet: ReadonlySet<string>,
): OutOfLaneProposal | null {
  if (proposal.op === 'add') {
    // An `add` puts a child somewhere, and WHERE is the only thing the lane
    // cares about. A `parentKey` that resolved and equals the leaf's parent is
    // a sibling; anything else — a different container, an intra-plan temp-ref
    // (which means the plan is building a subtree of its own), or no parent at
    // all (a root-level card) — is wider than this card's level.
    const parent = proposal.parentKey ?? null;
    if (lane.parentKey !== null && parent !== null && sameKey(parent, lane.parentKey)) return null;
    return {
      op: 'add',
      affects: addTargetLabel(proposal, lane),
      reason:
        lane.parentKey === null
          ? 'the card has no parent, so it has no sibling level to add to'
          : `it adds a card outside ${lane.parentKey}`,
    };
  }

  // `modify` / `remove` affect exactly the item they name.
  const key = proposal.workItemKey;
  if (key === null) {
    return {
      op: proposal.op,
      affects: 'an item this run cannot resolve',
      reason: 'its target did not resolve to a key — it may be outside this project',
    };
  }
  if (inSet.has(key.toUpperCase())) return null;
  return {
    op: proposal.op,
    affects: key,
    reason: `it is neither ${lane.leafKey} nor one of its siblings`,
  };
}

/** What an out-of-lane `add` would touch, said as concretely as the plan allows. */
function addTargetLabel(proposal: LaneProposal, lane: Lane): string {
  if (proposal.parentKey) return `a new card under ${proposal.parentKey}`;
  const ref = proposal.parentRef ?? null;
  if (ref !== null && ref.startsWith('planItem:')) {
    return 'a new card under another card this same plan proposes';
  }
  if (ref !== null) return 'a new card under a parent this run cannot resolve';
  return lane.parentKey === null ? 'a new top-level card' : 'a new card with no parent';
}

function sameKey(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/**
 * What the operator is told when the loop DECLINED to approve.
 *
 * ⚠️ IT IS NOT A FAILURE, and the first line has to say so — the same reason
 * `renderReplanSubmitted` opens the way it does. The agent found something real,
 * the plan is intact and waiting, and the only thing that happened is that this
 * run would not decide it alone. An operator who reads a decline as an error
 * learns to distrust the bound.
 *
 * ⚠️ AND IT NAMES THE ALTERNATIVE. A refusal that says only what it would not do
 * leaves the reader to work out what will. This one says where the plan is and
 * who decides it, which is the whole of what they need.
 */
export function renderLaneDecline(
  key: string,
  verdict: { outOfLane: OutOfLaneProposal[] },
): string {
  const lines = [
    `${key}: its re-plan was NOT auto-approved — the plan reaches beyond this card's own lane.`,
    'This is not a failure. The plan is submitted and intact; it goes to a person, which is',
    'what a correction wider than one card and its siblings is supposed to do.',
    '',
    `Out of lane (${verdict.outOfLane.length}):`,
    ...verdict.outOfLane.map((p) => `  ${p.op} ${p.affects} — ${p.reason}`),
    '',
    `Review the plan in Motir, then re-run ${key} if the corrected card survives.`,
  ];
  return lines.join('\n');
}

/**
 * What the operator is told when the agent anchored its plan somewhere ELSE.
 *
 * ⚠️ THIS IS THE ELECTION, WORKING — not a missing plan. `approveWorkItemPlan`
 * resolves through the conversation anchored at THIS card's key and nothing
 * else, so an agent that deliberately anchored at a container, or at nothing,
 * has put its plan structurally out of the loop's reach. The prompt tells it
 * that lane is always available and that choosing it is legitimate, so the run
 * must report the outcome it asked for rather than an error about a plan it
 * could not find.
 *
 * ⚠️ AND IT NAMES THE SUPPLIED TARGET WHERE THERE IS ONE. A value accepted and
 * discarded is the failure this whole lane exists to stop; a plan anchored
 * somewhere the loop cannot reach is the same shape seen from the other side, so
 * it is REPORTED rather than ignored.
 */
export function renderElsewhereAnchored(key: string, serverMessage: string): string {
  return [
    `${key}: its re-plan is not anchored at this card, so this run does not approve it.`,
    'The agent elected the lane that goes to a person — a mis-planned container, or a',
    'precondition no card names yet — which is a first-class choice, not a mistake.',
    `  ${serverMessage}`,
    'Review the submitted plan in Motir. Nothing was recorded for this card by this run.',
  ].join('\n');
}
