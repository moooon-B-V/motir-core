/** The `errorCode` a guide-seeded send ends on when its offer is no longer open — the
 *  rail words it as `planningWorkspace.guideSeed.offerClosed`.
 *
 *  Lives in its own module (not beside the conversation hook) so the rail can read it
 *  while a test replaces the hook module wholesale. */
export const GUIDE_OFFER_CLOSED = 'GUIDE_OFFER_CLOSED';
