// THE RE-PLAN OFFER'S DECLINE MARKER (Story MOTIR-8684 · MOTIR-8689; decision
// MOTIR-8685). A guide turn's `needs_replan` offer is DERIVED, not stored: the
// assistant turn carries the offer, and a plan turn is immutable, so declining
// is a `system` marker turn that names the offer's turn id. "Confirmed" is read
// off the planning session stamped with that same turn id, never off a marker.

const PREFIX = 'Declined the re-plan offer: ';

/** The persisted body of a decline marker for the offer on `turnId`. */
export function guideOfferDeclinedBody(turnId: string): string {
  return `${PREFIX}${turnId}`;
}

/** The offer turn id a `system` body declines, or null when it is not a marker. */
export function parseGuideOfferDeclined(body: string): string | null {
  return body.startsWith(PREFIX) && body.length > PREFIX.length ? body.slice(PREFIX.length) : null;
}
