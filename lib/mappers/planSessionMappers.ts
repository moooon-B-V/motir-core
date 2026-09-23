import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type { PlanStatusDto } from '@/lib/dto/plans';
import type { PlanSessionRowDto } from '@/lib/dto/planSessions';
import type { PlanSessionListRow } from '@/lib/repositories/planChangeSessionRepository';

/**
 * One raw session-list row → the row DTO (MOTIR-6025). The latest plan's title
 * falls back to its summary, so an agent plan that named itself only in prose
 * still reads as something; an empty string is no title.
 */
export function toPlanSessionRowDto(row: PlanSessionListRow): PlanSessionRowDto {
  return {
    id: row.id,
    origin: row.origin as PlanSessionOriginDto,
    targetKeys: row.targetKeys,
    lastActivityAt: row.lastActivityAt.toISOString(),
    startedBy:
      row.starterId && row.starterName ? { id: row.starterId, name: row.starterName } : null,
    firstTurn: row.firstTurn?.trim() || null,
    latestPlan: row.planId
      ? {
          id: row.planId,
          status: row.planStatus as PlanStatusDto,
          title: row.planTitle?.trim() || row.planSummary?.trim() || null,
        }
      : null,
    planCount: row.planCount,
  };
}
