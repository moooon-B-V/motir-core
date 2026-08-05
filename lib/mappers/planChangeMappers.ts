import type { PlanChangeSession, PlanChangeTurn } from '@prisma/client';
import type {
  PlanChangeSessionDto,
  PlanChangeTurnDto,
  PlanChangeTurnRoleDto,
} from '@/lib/dto/planChange';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// Prisma rows → API DTOs for the plan-change conversation (Story 7.30 ·
// MOTIR-1728). The single place the persisted enum narrows to its string union
// and Dates become ISO strings, so no Prisma row leaks past the service boundary
// (the 4-layer rule). `workspaceId` is deliberately NOT carried across the
// boundary — the client never needs the tenant id, and omitting it keeps the
// tenancy an entirely server-side concern.

export function toPlanChangeTurnDto(row: PlanChangeTurn): PlanChangeTurnDto {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role as PlanChangeTurnRoleDto,
    body: row.body,
    jobId: row.jobId,
    question: row.question,
    isAnswer: row.isAnswer,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The session plus its FULL ordered thread — the resume payload. `turns` MUST
 *  already be in `seq` order (the repository read orders them); the mapper does
 *  not re-sort, so a caller passing an unordered list gets an unordered DTO. */
export function toPlanChangeSessionDto(
  row: PlanChangeSession,
  turns: PlanChangeTurn[],
  workItemRefs: WorkItemRefMap = {},
): PlanChangeSessionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    // The anchor set crosses the boundary; the derived `scopeKey` it is stored
    // under does not (the client never needs the discriminator, only the items).
    targetKeys: row.targetKeys,
    turnCount: row.turnCount,
    lastJobId: row.lastJobId,
    lastSubmittedAt: row.lastSubmittedAt ? row.lastSubmittedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    turns: turns.map(toPlanChangeTurnDto),
    workItemRefs,
  };
}
