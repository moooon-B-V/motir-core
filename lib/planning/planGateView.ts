import type { PlanReviewDto } from '@/lib/dto/planReview';

// WHAT THE PLANNING SURFACE'S DECISION CONTROLS SHOW for the plan in hand (Story
// MOTIR-6012 · MOTIR-6037; `design/ai-planning/design-notes.md` Part XX §20.4–§20.5).
// ONE derivation, read by both the canvas bar and the rail's review block, so the gate
// and its mirror cannot disagree about which state they are in.
//
//   · `ungated`  — nobody has been asked about this proposal (no gate, or a gate that is
//                  no longer awaiting): the shipped *Discard* / *Approve changes* words.
//                  A `planned` plan with no gate is *not decidable yet*; its press is
//                  refused by the door and the rail says so (MOTIR-6038's copy).
//   · `seeOnly`  — the reader lacks `ai:decide_plan`: NO verbs at all, not disabled
//                  ones (the frame's state-B rule), and who the question waits on.
//   · `held`     — a revision holds the plan (§11.5c): both verbs DISABLED, not removed,
//                  with the reason in place of the consequence line. Held when the
//                  review read says so, and — before that read can — while THIS
//                  surface's own run is rewriting the plan in hand.
//   · `decide`   — Decline and Approve, with the consequence line.

export type PlanGateView =
  | { kind: 'ungated' }
  | { kind: 'seeOnly'; waitingOn: string | null }
  | { kind: 'held'; heldBy: string | null }
  | { kind: 'decide' };

export function planGateView(input: {
  review: PlanReviewDto | null;
  /** A plan run of THIS surface is streaming into the plan in hand. */
  rewriting: boolean;
}): PlanGateView {
  const gate = input.review?.gate;
  if (!gate || gate.state !== 'awaiting') return { kind: 'ungated' };
  if (!gate.canDecide) return { kind: 'seeOnly', waitingOn: gate.routedToName ?? null };
  if (gate.held) return { kind: 'held', heldBy: gate.held.heldBy };
  if (input.rewriting) return { kind: 'held', heldBy: null };
  return { kind: 'decide' };
}

/** Which of the surface's two decision places a press or a confirm came from. */
export type PlanDecisionPlace = 'bar' | 'rail';
