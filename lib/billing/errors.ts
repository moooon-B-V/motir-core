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

// ── The billing boundary surface (Story 8.1.6) errors ──────────────────────

/**
 * Billing is not available on this build — a self-hosted (GPL-3.0) deploy where
 * `MOTIR_CLOUD` is off (ADR §6). Maps to 404: the commercial surface simply does
 * not exist off-cloud, rather than existing-but-forbidden.
 */
export class BillingNotAvailableError extends Error {
  readonly code = 'BILLING_NOT_AVAILABLE';
  constructor() {
    super('Billing is only available on Motir cloud.');
    this.name = 'BillingNotAvailableError';
  }
}

/**
 * The actor is an org member who lacks the role this billing action needs (ADR
 * §7: viewing billing is owner/admin; every MUTATION — checkout / portal /
 * change plan / cancel — is OWNER-ONLY). The org IS visible to them, so this is
 * 403, distinct from the not-found gate (404) that hides orgs they aren't in.
 */
export class BillingForbiddenError extends Error {
  readonly code = 'BILLING_FORBIDDEN';
  constructor(detail: string) {
    super(detail);
    this.name = 'BillingForbiddenError';
  }
}

/**
 * Checkout was asked to start a price the catalog does not offer — a stale or
 * tampered identifier. Maps to 400 (a client-correctable bad input).
 */
export class UnknownBillingPriceError extends Error {
  readonly code = 'BILLING_UNKNOWN_PRICE';
  constructor(priceLookupKey: string) {
    super(`Unknown billing price: ${priceLookupKey}`);
    this.name = 'UnknownBillingPriceError';
  }
}
