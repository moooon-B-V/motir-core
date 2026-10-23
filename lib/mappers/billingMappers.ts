import type { Organization } from '@/generated/prisma/client';
import type {
  RawDowngradePreview,
  RawDowngradeResult,
  RawPendingDowngrade,
  RawUpgradePreview,
  RawUpgradeResult,
} from '@/lib/ai/types';
import type {
  DowngradePreviewDTO,
  DowngradeResultDTO,
  PendingPlanChangeDTO,
  UpgradePreviewDTO,
  UpgradeResultDTO,
  AiIncludedSeatDTO,
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

// ── The plan-change boundary (MOTIR-8399) ────────────────────────────────────
// motir-ai's previews and confirms → the DTOs the dialogs read. Each field is
// picked by name, so a field motir-ai adds does not cross into the browser
// unless it is named here.

export function toPendingPlanChangeDTO(
  pending: RawPendingDowngrade | null | undefined,
): PendingPlanChangeDTO | null {
  return pending ? { planKey: pending.planKey, effectiveDate: pending.effectiveDate } : null;
}

export function toUpgradePreviewDTO(raw: RawUpgradePreview): UpgradePreviewDTO {
  return {
    prorationDate: raw.prorationDate,
    fromPlan: raw.fromPlan,
    toPlan: raw.toPlan,
    cadence: raw.cadence,
    cadenceChange: raw.cadenceChange ?? null,
    amountDueCents: raw.amountDueCents,
    currency: raw.currency,
    periodEnd: raw.periodEnd,
    billingDaysLeft: raw.billingDaysLeft,
    daysLeft: raw.daysLeft,
    creditWindowEnd: raw.creditWindowEnd,
    extraCredits: raw.extraCredits,
    extraIndexAllowance: raw.extraIndexAllowance,
    fromPool: raw.fromPool,
    fullPool: raw.fullPool,
    fullAllowance: raw.fullAllowance,
    toPriceCents: raw.toPriceCents,
    pendingDowngrade: toPendingPlanChangeDTO(raw.pendingDowngrade),
  };
}

export function toUpgradeResultDTO(raw: RawUpgradeResult): UpgradeResultDTO {
  return {
    status: 'upgraded',
    fromPlan: raw.fromPlan,
    toPlan: raw.toPlan,
    extraCredits: raw.extraCredits,
    extraIndexAllowance: raw.extraIndexAllowance,
    clearedPending: toPendingPlanChangeDTO(raw.clearedPending),
  };
}

export function toDowngradePreviewDTO(raw: RawDowngradePreview): DowngradePreviewDTO {
  return {
    fromPlan: raw.fromPlan,
    toPlan: raw.toPlan,
    cadence: raw.cadence,
    cadenceChange: raw.cadenceChange ?? null,
    effectiveDate: raw.effectiveDate,
    fromPool: raw.fromPool,
    fullPool: raw.fullPool,
    fullAllowance: raw.fullAllowance,
    toPriceCents: raw.toPriceCents,
    currency: raw.currency,
    pendingDowngrade: toPendingPlanChangeDTO(raw.pendingDowngrade),
  };
}

export function toDowngradeResultDTO(raw: RawDowngradeResult): DowngradeResultDTO {
  if (raw.status === 'cleared') {
    return {
      status: 'cleared',
      fromPlan: raw.fromPlan,
      toPlan: raw.toPlan,
      clearedPending: toPendingPlanChangeDTO(raw.clearedPending)!,
    };
  }
  return {
    status: 'scheduled',
    fromPlan: raw.fromPlan,
    toPlan: raw.toPlan,
    effectiveDate: raw.effectiveDate,
    replacedPending: toPendingPlanChangeDTO(raw.replacedPending),
  };
}
