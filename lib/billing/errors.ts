// Typed errors for the billing-propagation surface (Story 8.1). The route layer
// translates these to HTTP status codes; the service throws them. (Org-not-found
// reuses `OrganizationNotFoundError` from lib/organizations/errors.ts — the org
// is an existing entity, not a billing-owned one.)

/**
 * The inbound billing-state body failed validation — a missing/empty
 * organizationId, or a `scaledTrackerSubscription` that is neither null nor a
 * well-formed `{ status, priceId, currentPeriodEnd }`. Maps to 400.
 */
export class ScaledTrackerStateValidationError extends Error {
  readonly code = 'SCALED_TRACKER_STATE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'ScaledTrackerStateValidationError';
  }
}
