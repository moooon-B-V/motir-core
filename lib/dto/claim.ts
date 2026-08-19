// The KEYED CLAIM result (MOTIR-2961).
//
// `claim_next_ready` (MOTIR-1330) made the path that asks "give me whatever is
// next" race-safe. This is the shape the path that is HANDED a card by name
// answers with — and the reason it is a RESULT rather than an error is the
// whole point of the card: a rejection that says only "not in `todo`" forces
// the loser into a second read to find out whether it lost a race, is looking
// at its own interrupted run, or was pointed at finished work. Those three call
// for three different next moves, so they are three different values here.

/** An actor named on a claim result — the minimal ACTOR object (ADR Amendment 10 Q1). */
export interface ClaimActorDto {
  id: string;
  name: string;
}

/**
 * What a claim attempt resolved to.
 *
 * - `claimed` — the item was in the to-do CATEGORY (`todo` or `blocked`); it is
 *   now assigned to the caller and `in_progress`, both written under one lock.
 * - `mine` — already `in_progress` and already assigned to the CALLER. The
 *   documented recovery: a run resuming a card its own failed agent left behind.
 *   The caller proceeds.
 * - `taken` — `in_progress` and NOT the caller's. Somebody else is on it.
 * - `not_claimable` — outside the to-do category and not `in_progress`
 *   (`implemented`, `in_review`, `planning`, `done`, `cancelled`, any custom
 *   status, a status the project's workflow does not define, or an ARCHIVED
 *   row). The card is not available to a run at all, and `taken` would be the
 *   wrong word for a card that is finished.
 */
export type WorkItemClaimOutcome = 'claimed' | 'mine' | 'taken' | 'not_claimable';

/** The result of one keyed claim attempt. */
export interface WorkItemClaimDto {
  /** The item's `MOTIR-<n>` key. */
  key: string;
  /** Its title, so a refusal reads without a second call. */
  title: string;
  outcome: WorkItemClaimOutcome;
  /** `outcome === 'claimed'` — the field the card names, kept as its own so a
   *  caller can branch on the happy path without knowing the vocabulary. */
  claimed: boolean;
  /** The status the item is at AFTER this call — the new one on a claim, the
   *  untouched one on every refusal. `category` is `null` for a status the
   *  project's workflow does not define; an unknown category is never the to-do
   *  category, so such a card is `not_claimable`. */
  status: { key: string; category: string | null };
  /** Who the item is assigned to now. The caller on a claim; on a refusal, the
   *  holder the loser can name — `null` when a sibling flipped the status
   *  without ever assigning (the MOTIR-2958 shape). */
  assignee: ClaimActorDto | null;
  /** WHO performed the status transition that put the item where it is. On a
   *  claim that is the caller and this call; on a refusal it is the winner —
   *  and it is the field that names them even when nothing was assigned. */
  transitionedBy: ClaimActorDto | null;
  /** WHEN that transition happened, ISO-8601. `null` for an item whose status
   *  was never moved (a row imported straight into its status). */
  transitionedAt: string | null;
}
