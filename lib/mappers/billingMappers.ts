import type { Organization } from '@prisma/client';
import type { ScaledTrackerStateDTO } from '@/lib/dto/billing';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// Prisma → DTO converters for the billing-propagation domain (Story 8.1). The
// service calls these just before returning so no Prisma row shape leaks across
// the API boundary. Mirrors lib/mappers/organizationMappers.ts.

export function toScaledTrackerStateDTO(org: Organization): ScaledTrackerStateDTO {
  return {
    organizationId: org.id,
    // The column is written ONLY through parseSetScaledTrackerStateInput +
    // updateScaledTrackerState, so its JSON shape is exactly
    // ScaledTrackerSubscription (or SQL NULL → null).
    scaledTrackerSubscription:
      (org.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null,
  };
}
