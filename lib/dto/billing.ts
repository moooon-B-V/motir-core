import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// DTOs for the billing-propagation surface (Story 8.1). Defines EXACTLY what
// crosses the HTTP boundary — no Prisma model leaks. The inbound route returns
// the confirmation DTO so motir-ai's coreClient (8.1.4d) can read back the
// persisted state.

export interface ScaledTrackerStateDTO {
  organizationId: string;
  /** The persisted state, or `null` when no scaled-tracker subscription is set. */
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
}
