import type { Label } from '@prisma/client';
import type { LabelDto } from '@/lib/dto/labels';

/**
 * Prisma `Label` → wire DTO (Story 5.4 · Subtask 5.4.2). Drops the tenancy
 * scalars (`workspaceId`/`projectId` — implicit in the routes that serve it)
 * and `nameLower` (a server-side uniqueness key, not display data).
 */
export function toLabelDto(row: Label): LabelDto {
  return { id: row.id, name: row.name };
}
