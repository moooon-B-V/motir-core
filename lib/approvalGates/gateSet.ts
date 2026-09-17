import type { ApprovalGateState } from '@/generated/prisma/client';

// THE GATE-SET PREDICATE — which questions a card should currently be ASKING
// (Story MOTIR-5652 · Subtask MOTIR-5660; ADR `docs/decisions/design-result.md`
// AMENDMENT 6, `docs/decisions/approval-gates.md` §1's MOTIR-5658 amendment).
//
// ⚠️ THE QUESTION NO INDIVIDUAL RAISER COULD ANSWER, AND THAT IS THE WHOLE
// POINT. Before this module, which gates a card held was the emergent sum of
// eleven call sites across five services: four that CREATE a gate row and seven
// that supersede one. Each asked a narrow question about its own trigger —
// *should I raise a merge gate?*, *should I retire the design gate?* — and none
// asked *what should this card have?* Every defect in that family lived in the
// space between two locally-correct answers:
//
//   · MOTIR-5603 — two MERGE gates, because two raisers could not see each other.
//   · MOTIR-5604 — a push withdrew the gate and the next green raised nothing,
//     because a withdrawer had no matching raiser.
//   · MOTIR-5652 — NO gate at all, because two suppressors could not see each
//     other: the design gate was suppressed on the reasoning that the merge gate
//     would carry the decision, and the merge gate then refused on the run target.
//
// ⚠️ IT ANSWERS A SET WITH A PRIMARY, NOT ONE GATE. AMENDMENT 6 Q1: a design
// card with a published result and open pull requests has TWO questions, and
// they have different lifetimes — *is this design right?* is durable, *do these
// commits land?* is per attempt. Collapsing them is the mistake this level
// reverses, so a predicate that returned one gate would encode the same error one
// layer deeper, where it would be much harder to see.
//
// ⚠️ PURE, AND DELIBERATELY SO. No repository call, no Prisma client, no
// transaction. Every caller already holds these facts under its own lock, so this
// adds no query, no writer and no lock ordering — and its tests need no fixtures.
// It imports one TYPE and nothing else.
//
// ⚠️ AND IT HAS NO CALLER YET (MOTIR-5660). The conversion of the eleven sites is
// MOTIR-5662 (the raisers) and MOTIR-5663 (the withdrawers). This module ships
// alone so it can be reviewed as an ANSWER — read against AMENDMENT 6 line by
// line — before any behaviour depends on it. A card that both defined the rule
// and applied it could not be reviewed for the rule.

/** The kinds this predicate decides between. */
export type AwaitableGateKind = 'design_result' | 'pull_request_approval';

/** One member of the card's delivery set, reduced to what the answer depends on. */
export interface GateSetMember {
  /**
   * `owner/name#number@headSha` — `deliveryMemberVersion`'s spelling, so a member
   * here and that pull request's own gate can never disagree about its head. Null
   * when no head is known, which is NOT the same as "not a candidate": a set with
   * an unknown head cannot be named at all (`deliverySetVersion` returns null).
   */
  memberVersion: string | null;
  /**
   * Whether this member could be merged NOW — open, on a provider that can merge,
   * green at its latest head (`mergeCandidateHead` answers it). MOTIR-5604's
   * refusal, moved here from `raisePullRequestApprovalGate`'s guard chain.
   */
  isMergeCandidate: boolean;
}

/** A gate the card already has, reduced to what decides whether it still answers. */
export interface ExistingGate {
  state: ApprovalGateState;
  /** The `DesignEvidence` id for a design gate; the card's own id for a merge gate. */
  subjectId: string;
  subjectVersion: string | null;
}

export interface GateSetInput {
  /**
   * The card's CURRENT non-withdrawn design result, or null. Current-ness is right
   * here and wrong in `designResultHandler.resolveSubject`, for opposite reasons:
   * that one answers *what was THIS gate asked about* and must never re-point; this
   * answers *what would a gate raised NOW ask about*.
   */
  currentDesignEvidence: { id: string; commitSha: string | null } | null;
  /** The card's most recent `design_result` gate, whatever its state, or null. */
  latestDesignGate: ExistingGate | null;
  /** The card's most recent approve-to-merge gate, whatever its state, or null. */
  latestMergeGate: ExistingGate | null;
  /** Every pull request the card delivers. Empty when it delivers none. */
  members: readonly GateSetMember[];
  /** The project's `prMergeMode`. In `auto` Motir merges with no person. */
  prMergeMode: string | null;
  /**
   * Whether the card's status sits in its project's DONE category (`cancelled`
   * included) — resolved by the caller through the workflow, never by comparing a
   * key to `'done'`, so a renamed done status is closed too.
   */
  cardIsTerminal: boolean;
  /** The card's own id — a merge gate's `subjectId` is the card (MOTIR-5603). */
  workItemId: string;
}

/** One question the card should be asking. */
export interface AwaitedGate {
  kind: AwaitableGateKind;
  subjectId: string;
  subjectVersion: string | null;
}

export interface GateSet {
  /**
   * The questions the card should currently be ASKING — what SHOULD be `awaiting`.
   * A caller reconciles: raise what is here and absent, supersede what is absent
   * here and awaiting. A gate that is already DECIDED is not in this set, because
   * it is an answer rather than a question.
   */
  awaited: readonly AwaitedGate[];
  /**
   * Which of `awaited` is PRESENTED as the thing being decided (AMENDMENT 6 Q1).
   * The design gate whenever it is awaited — it carries the question a person is
   * actually answering — else the merge gate, else null. After the design has been
   * decided and a merge later fails, the merge gate is awaited alone and is
   * therefore primary (Q2).
   */
  primary: AwaitableGateKind | null;
}

/**
 * Does this gate already ANSWER the question, rather than ask it?
 *
 * A gate `approved` or `changes_requested` over the same subject AND the same
 * version is a decision somebody made about exactly this thing. `awaiting` is the
 * question still open — which still belongs in `awaited`, so a reconciling caller
 * leaves it alone instead of superseding and re-raising an identical row (the
 * idempotence MOTIR-5670 tests hardest).
 */
function alreadyDecided(
  gate: ExistingGate | null,
  subjectId: string,
  subjectVersion: string | null,
): boolean {
  if (gate === null) return false;
  if (gate.state !== 'approved' && gate.state !== 'changes_requested') return false;
  return gate.subjectId === subjectId && gate.subjectVersion === subjectVersion;
}

/**
 * The canonical version of the delivery SET — each member sorted and joined, so the
 * same set always gives the same string. Null for an empty set and null when ANY
 * member's head is unknown: a set version with a hole in it would claim commits
 * nobody can name.
 *
 * ⚠️ IT DUPLICATES `deliverySetVersion`'s RULE AND NOT ITS CODE, deliberately.
 * That helper takes repository row types; this module is pure over plain values so
 * its tests need no fixtures. The two must agree, and `tests/` asserts it rather
 * than trusting the comment.
 */
function setVersion(members: readonly GateSetMember[]): string | null {
  if (members.length === 0) return null;
  const versions = members.map((member) => member.memberVersion);
  if (versions.some((version) => version === null)) return null;
  return [...(versions as string[])].sort().join(',');
}

/**
 * WHICH GATES this card should be asking, and which one leads.
 *
 * The whole answer, in the order the ADR states it:
 *
 *  1. **A terminal card asks nothing.** Its work is over; a question on it could
 *     never be acted on.
 *  2. **The DESIGN question** is owed whenever the card has a current design result
 *     that no decision has answered. It does NOT depend on pull requests, on CI, or
 *     on who holds the run target — AMENDMENT 6 Q1 reverses AMENDMENT 4 Q8's
 *     suppression, and MOTIR-5652's run-target refusal is not represented here at
 *     all because a card with something to decide has a gate regardless of it.
 *  3. **The MERGE question** is owed in a `manual` project when the card delivers at
 *     least one pull request, EVERY member could be merged now, and no decision has
 *     already answered these exact commits. The candidacy check is MOTIR-5604's and
 *     the same-commits check is MOTIR-5632's; both survive as inputs rather than as
 *     guards scattered across raisers.
 *  4. **The DESIGN gate is primary** whenever both are owed (Q1). A merge gate owed
 *     alone — after an approval whose merge then failed — leads by itself (Q2).
 */
export function resolveGateSet(input: GateSetInput): GateSet {
  if (input.cardIsTerminal) return { awaited: [], primary: null };

  const awaited: AwaitedGate[] = [];

  const evidence = input.currentDesignEvidence;
  if (
    evidence !== null &&
    !alreadyDecided(input.latestDesignGate, evidence.id, evidence.commitSha)
  ) {
    awaited.push({
      kind: 'design_result',
      subjectId: evidence.id,
      subjectVersion: evidence.commitSha,
    });
  }

  const version = setVersion(input.members);
  const everyMemberMergeable =
    input.members.length > 0 && input.members.every((member) => member.isMergeCandidate);
  if (
    input.prMergeMode === 'manual' &&
    everyMemberMergeable &&
    version !== null &&
    !alreadyDecided(input.latestMergeGate, input.workItemId, version)
  ) {
    awaited.push({
      kind: 'pull_request_approval',
      subjectId: input.workItemId,
      subjectVersion: version,
    });
  }

  const primary: AwaitableGateKind | null =
    awaited.find((gate) => gate.kind === 'design_result')?.kind ?? awaited[0]?.kind ?? null;

  return { awaited, primary };
}
