import type { Folder } from '@/generated/prisma/client';
import type { FolderDto } from '@/lib/dto/folders';

/**
 * Prisma `Folder` → wire DTO (Story MOTIR-5308 · MOTIR-5313). Drops the tenancy
 * scalar `workspaceId` and serialises the timestamps as ISO-8601.
 */
export function toFolderDto(row: Folder): FolderDto {
  return {
    id: row.id,
    projectId: row.projectId,
    parentFolderId: row.parentFolderId,
    name: row.name,
    position: row.position,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
