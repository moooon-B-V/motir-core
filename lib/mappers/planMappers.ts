// Prisma → DTO converters for the Plan substrate (Story 7.21 · MOTIR-1336).
// Services call these just before returning, so no Prisma row (Date objects,
// the enum types, the raw Json columns) ever crosses the API boundary.

import type { Plan, PlanItem } from '@prisma/client';
import type {
  PlanDto,
  PlanItemDto,
  PlanItemPatch,
  PlanItemProposedFields,
  PlanWithItemsDto,
} from '@/lib/dto/plans';

export function toPlanItemDto(row: PlanItem): PlanItemDto {
  return {
    id: row.id,
    op: row.op,
    workItemId: row.workItemId,
    // The Json columns are written through the typed service inputs, so the
    // cast restores the shape the writer stored (null when the column is null).
    proposedFields: (row.proposedFields as PlanItemProposedFields | null) ?? null,
    patch: (row.patch as PlanItemPatch | null) ?? null,
    parentRef: row.parentRef,
    blockedByRefs: row.blockedByRefs,
    baseRevision: row.baseRevision,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A plan list-row DTO. `itemCount` is supplied by the caller (a COUNT or the
 *  length of an already-loaded items array). */
export function toPlanDto(row: Plan, itemCount: number): PlanDto {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    title: row.title,
    summary: row.summary,
    sourceJobId: row.sourceJobId,
    itemCount,
    createdAt: row.createdAt.toISOString(),
    plannedAt: row.plannedAt ? row.plannedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedById: row.decidedById,
  };
}

export function toPlanWithItemsDto(row: Plan, items: PlanItem[]): PlanWithItemsDto {
  return {
    ...toPlanDto(row, items.length),
    items: items.map(toPlanItemDto),
  };
}
