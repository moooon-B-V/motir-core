// THE GUIDE-OFFER SEED (Story MOTIR-8684 · MOTIR-8692; decision MOTIR-8685). The
// pure half of the seed a guide's re-plan offer gives the planning surface: the
// first turn is the guide's request VERBATIM, and only an offer that can still start
// or reopen something is seedable.
import type { GuideReplanOffer } from '@/lib/ai/guideWorkItem';
import type { GuideReplanOfferState } from '@/lib/planning/guideReplanOffer';

/**
 * The first turn the overlay SENDS: the offer's `requestMd`, trimmed and otherwise
 * byte for byte. No lead line, no translation, no re-wording — the guide wrote it
 * to a planner who was not in the conversation, and the person's Confirm is consent
 * to send exactly that. A blank result is `null` (the landing never stores one), and
 * the service treats `null` as not seedable.
 */
export function composeGuideSeedFirstTurn(
  offer: Pick<GuideReplanOffer, 'requestMd'>,
): string | null {
  const text = offer.requestMd.trim();
  return text === '' ? null : text;
}

/** Whether an offer in `state` can be seeded: it can still be confirmed
 *  (`undecided`) or its session reopened (`confirmed`). A declined or superseded
 *  one can do neither, and a turn with no offer (`null`) has nothing to seed. */
export function isGuideSeedableState(
  state: GuideReplanOfferState | null,
): state is 'undecided' | 'confirmed' {
  return state === 'undecided' || state === 'confirmed';
}
