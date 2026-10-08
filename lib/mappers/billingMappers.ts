import type { EnterpriseRequest, Organization } from '@/generated/prisma/client';
import type {
  AiIncludedSeatDTO,
  EnterpriseRequestDTO,
  EnterpriseRequestOrgStatus,
  ScaledTrackerStateDTO,
} from '@/lib/dto/billing';
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

export function toAiIncludedSeatDTO(org: Organization): AiIncludedSeatDTO {
  return { organizationId: org.id, aiIncludedSeat: org.aiIncludedSeat };
}

const ORG_STATUS: Record<EnterpriseRequest['status'], EnterpriseRequestOrgStatus> = {
  new: 'received',
  contacted: 'in_conversation',
  offer_sent: 'offer_sent',
  won: 'closed',
  lost: 'closed',
};

/** The org's view of an Enterprise request (MOTIR-7605) — staff's states folded
 *  into the org's words, and nothing the org did not give or cannot see. */
export function toEnterpriseRequestDTO(
  row: EnterpriseRequest,
  requestedByName: string | null,
): EnterpriseRequestDTO {
  return {
    id: row.id,
    status: ORG_STATUS[row.status],
    createdAt: row.createdAt.toISOString(),
    cardsPerDay: row.cardsPerDay,
    parallelAgents: row.parallelAgents,
    agentPath: row.agentPath,
    autonomy: row.autonomy,
    startWhen: row.startWhen,
    teamSize: row.teamSize,
    contact: row.contact,
    note: row.note,
    requestedByName,
  };
}
