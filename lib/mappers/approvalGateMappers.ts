import type { ApprovalGate } from '@/generated/prisma/client';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// Prisma row → the wire DTO the decide control / Approvals tab reads (Story
// MOTIR-4778 · Subtask MOTIR-4788, widened by MOTIR-4912 with the ADR §6a AUDIT
// set). The service layer calls this just before returning (CLAUDE.md — services
// never return raw Prisma models). The kind / state / authority / source enums
// are string-literal unions on both sides, so they map straight through; dates
// become ISO strings, matching the work-items / acceptance-evidence DTO
// convention.
//
// ⚠️ THE AUDIT FIELDS ARE MAPPED EXPLICITLY, AND THE MAPPER IS NOT A SPREAD.
// That is what makes this file the boundary it claims to be: adding a column to
// `ApprovalGate` does NOT silently widen the wire shape, and REMOVING one from
// the DTO fails the type-check here rather than dropping quietly out of an API
// response. A `...row` would make the DTO's own declaration decorative.

/** Prisma row → the wire DTO. */
export function toApprovalGateDto(row: ApprovalGate): ApprovalGateDTO {
  return {
    id: row.id,
    workItemId: row.workItemId,
    kind: row.kind,
    subjectId: row.subjectId,
    state: row.state,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    noteMd: row.noteMd,
    // The audit set (ADR §6a). Every one is nullable on the row and stays
    // nullable on the wire — a null is "not decided yet", and collapsing one to
    // a placeholder here would be the mapper asserting something the record
    // does not say.
    subjectVersion: row.subjectVersion,
    decidedByLabel: row.decidedByLabel,
    routedToId: row.routedToId,
    decidedUnderAuthority: row.decidedUnderAuthority,
    decisionSource: row.decisionSource,
    outcomeRef: row.outcomeRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
