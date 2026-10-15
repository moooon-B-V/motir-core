// THE RE-PLAN OFFER'S STATE (Story MOTIR-8684 · MOTIR-8689; decision MOTIR-8685).
// A guide reply turn may hold a stored re-plan offer (`GuideTurnRecord.replanOffer`).
// Whether it can still be acted on is DERIVED here, from the thread, so the Decline
// door, the Confirm start, the seed read and the rail all read ONE rule:
//
//   - `declined`   — `declinedAt` is set (a person's act, written under the lock);
//   - `superseded` — a LATER assistant turn in the thread holds an offer (position,
//                    never written, so a revised offer needs no second write);
//   - `undecided`  — the latest offer, neither of the above.
import type { GuideReplanOffer, GuideTurnRecord } from '@/lib/ai/guideWorkItem';

export type GuideReplanOfferState = 'undecided' | 'superseded' | 'declined';

/** The slice of a thread turn this reads (a `PlanChangeTurnDto` fits). */
export interface ReplanOfferTurn {
  id: string;
  role: string;
  guide?: GuideTurnRecord | null;
}

function offerOf(turn: ReplanOfferTurn): GuideReplanOffer | null {
  return turn.role === 'assistant' ? (turn.guide?.replanOffer ?? null) : null;
}

/** The offer on `turnId`, or null when that turn holds none. */
export function replanOfferOf(
  turns: readonly ReplanOfferTurn[],
  turnId: string,
): GuideReplanOffer | null {
  const turn = turns.find((t) => t.id === turnId);
  return turn ? offerOf(turn) : null;
}

/** `turnId`'s offer state, or null when that turn holds no offer. `turns` is the
 *  thread in order, oldest first. */
export function replanOfferStateOf(
  turns: readonly ReplanOfferTurn[],
  turnId: string,
): GuideReplanOfferState | null {
  const at = turns.findIndex((t) => t.id === turnId);
  const offer = at < 0 ? null : offerOf(turns[at]!);
  if (!offer) return null;
  if (offer.declinedAt !== null) return 'declined';
  return turns.slice(at + 1).some((t) => offerOf(t) !== null) ? 'superseded' : 'undecided';
}

/** The latest offer that can still be acted on, with its turn id, or null. */
export function latestUndecidedReplanOffer(
  turns: readonly ReplanOfferTurn[],
): { turnId: string; offer: GuideReplanOffer } | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const offer = offerOf(turns[i]!);
    if (!offer) continue;
    // The LATEST offer is the only one that can be undecided.
    return offer.declinedAt === null ? { turnId: turns[i]!.id, offer } : null;
  }
  return null;
}
