import type {
  AdminActor,
  AdminCreditWriteResult,
  AdminLedgerEntry,
  AdminLedgerRead,
  AdminPlanTier,
  AdminTierAssignment,
  AdminTierWriteResult,
} from '@/lib/ai/types';
import type {
  PlatformCreditActorDTO,
  PlatformCreditLedgerEntryDTO,
  PlatformCreditLedgerPageDTO,
  PlatformCreditTierAssignmentDTO,
  PlatformCreditTierDTO,
  PlatformCreditWriteDTO,
  PlatformPlanSetDTO,
} from '@/lib/dto/platformCreditOps';

/**
 * motir-ai's staff credit-op shapes → the console DTOs (MOTIR-747).
 *
 * Field-by-field rather than a spread, so a field motir-ai adds later (the
 * ledger row's `externalRef`, which is an idempotency key and not something an
 * operator reads) never reaches the page by accident.
 */

function toActorDTO(actor: AdminActor): PlatformCreditActorDTO {
  return { userId: actor.userId, label: actor.label };
}

export function toPlatformCreditLedgerEntryDTO(e: AdminLedgerEntry): PlatformCreditLedgerEntryDTO {
  return {
    id: e.id,
    at: e.at,
    kind: e.kind,
    credits: e.credits,
    balanceAfter: e.balanceAfter,
    reason: e.reason,
    actor: e.actor ? toActorDTO(e.actor) : null,
  };
}

export function toPlatformCreditTierDTO(t: AdminPlanTier): PlatformCreditTierDTO {
  return { key: t.key, name: t.name, cadence: t.cadence, allotmentCredits: t.allotmentCredits };
}

export function toPlatformCreditTierAssignmentDTO(
  a: AdminTierAssignment,
): PlatformCreditTierAssignmentDTO {
  return {
    id: a.id,
    at: a.at,
    fromTierKey: a.fromTierKey,
    toTierKey: a.toTierKey,
    reason: a.reason,
    actor: toActorDTO(a.actor),
  };
}

export function toPlatformCreditLedgerPageDTO(
  organizationId: string,
  read: AdminLedgerRead,
  largeGrantThresholdCredits: number,
): PlatformCreditLedgerPageDTO {
  const tier = read.tier ? toPlatformCreditTierDTO(read.tier) : null;
  const last = read.lastTierAssignment
    ? toPlatformCreditTierAssignmentDTO(read.lastTierAssignment)
    : null;
  return {
    organizationId,
    known: read.known,
    balanceCredits: read.balanceCredits,
    tier,
    lastTierAssignment: last,
    explainsCurrentTier: !!last && !!tier && last.toTierKey === tier.key,
    entries: read.entries.map(toPlatformCreditLedgerEntryDTO),
    nextCursor: read.nextCursor,
    largeGrantThresholdCredits,
  };
}

export function toPlatformCreditWriteDTO(
  organizationId: string,
  result: AdminCreditWriteResult,
  requestId: string,
): PlatformCreditWriteDTO {
  return {
    organizationId,
    entry: toPlatformCreditLedgerEntryDTO(result.transaction),
    balanceCredits: result.balanceCredits,
    idempotent: result.idempotent,
    requestId,
  };
}

export function toPlatformPlanSetDTO(
  organizationId: string,
  result: AdminTierWriteResult,
  requestId: string,
): PlatformPlanSetDTO {
  return {
    organizationId,
    assignment: toPlatformCreditTierAssignmentDTO(result.assignment),
    tier: toPlatformCreditTierDTO(result.tier),
    changed: result.changed,
    idempotent: result.idempotent,
    requestId,
  };
}
