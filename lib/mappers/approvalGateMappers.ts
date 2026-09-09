import type { ApprovalGate } from '@/generated/prisma/client';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// Prisma row → the wire DTO the decide control / Approvals tab reads (Story
// MOTIR-4778 · Subtask MOTIR-4788). The service layer calls this just before
// returning (CLAUDE.md — services never return raw Prisma models). The kind /
// state enums are string-literal unions on both sides, so they map straight
// through; dates become ISO strings, matching the work-items / acceptance-
// evidence DTO convention.

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
