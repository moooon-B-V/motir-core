import { ScaledTrackerStateValidationError } from '@/lib/billing/errors';

// The scaled-tracker (per-seat PM) subscription state propagated from motir-ai's
// Stripe webhook (8.1.4b) into motir-core's Organization (8.1.4c). This module
// owns the wire SHAPE + its hand-rolled validator (the parsePlanDelta idiom — a
// service-to-service contract validates its own input rather than trusting the
// caller). The persisted JSON column mirrors this type exactly; `null` = no
// scaled-tracker subscription (the default free state).

export const SCALED_TRACKER_STATUSES = ['active', 'past_due', 'canceled'] as const;
export type ScaledTrackerStatus = (typeof SCALED_TRACKER_STATUSES)[number];

export const SCALED_TRACKER_PRICE_IDS = ['tracker_monthly', 'tracker_annual'] as const;
export type ScaledTrackerPriceId = (typeof SCALED_TRACKER_PRICE_IDS)[number];

export interface ScaledTrackerSubscription {
  status: ScaledTrackerStatus;
  priceId: ScaledTrackerPriceId;
  /** Stripe's `current_period_end`, unix epoch SECONDS (a positive integer). */
  currentPeriodEnd: number;
}

export interface SetScaledTrackerStateInput {
  organizationId: string;
  /** The subscription state, or `null` to CLEAR it (cancel — non-destructive). */
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseScaledTrackerSubscription(v: unknown): ScaledTrackerSubscription {
  if (!isObject(v)) {
    throw new ScaledTrackerStateValidationError(
      'scaledTrackerSubscription must be an object or null',
    );
  }
  const { status, priceId, currentPeriodEnd } = v;
  if (!SCALED_TRACKER_STATUSES.includes(status as ScaledTrackerStatus)) {
    throw new ScaledTrackerStateValidationError(
      `status must be one of ${SCALED_TRACKER_STATUSES.join(', ')}`,
    );
  }
  if (!SCALED_TRACKER_PRICE_IDS.includes(priceId as ScaledTrackerPriceId)) {
    throw new ScaledTrackerStateValidationError(
      `priceId must be one of ${SCALED_TRACKER_PRICE_IDS.join(', ')}`,
    );
  }
  if (
    typeof currentPeriodEnd !== 'number' ||
    !Number.isInteger(currentPeriodEnd) ||
    currentPeriodEnd <= 0
  ) {
    throw new ScaledTrackerStateValidationError(
      'currentPeriodEnd must be a positive integer (unix epoch seconds)',
    );
  }
  return {
    status: status as ScaledTrackerStatus,
    priceId: priceId as ScaledTrackerPriceId,
    currentPeriodEnd,
  };
}

/**
 * Validate + narrow an untrusted inbound body into a `SetScaledTrackerStateInput`.
 * Throws `ScaledTrackerStateValidationError` (→ 400) on any malformed field.
 * `scaledTrackerSubscription: null` is valid (the cancel/clear path).
 */
export function parseSetScaledTrackerStateInput(body: unknown): SetScaledTrackerStateInput {
  if (!isObject(body)) {
    throw new ScaledTrackerStateValidationError('request body must be a JSON object');
  }
  const { organizationId, scaledTrackerSubscription } = body;
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new ScaledTrackerStateValidationError('organizationId must be a non-empty string');
  }
  // The key must be PRESENT (so a caller can't silently no-op by omitting it),
  // but its value may be null (clear) or a well-formed object (set).
  if (!('scaledTrackerSubscription' in body)) {
    throw new ScaledTrackerStateValidationError(
      'scaledTrackerSubscription is required (object to set, null to clear)',
    );
  }
  return {
    organizationId,
    scaledTrackerSubscription:
      scaledTrackerSubscription === null
        ? null
        : parseScaledTrackerSubscription(scaledTrackerSubscription),
  };
}
