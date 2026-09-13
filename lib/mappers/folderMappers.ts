import type { Folder } from '@/generated/prisma/client';
import type { FolderDto } from '@/lib/dto/folders';
import type { FolderTreeRowDto } from '@/lib/dto/workItems';

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

/** The row `folderRepository.findLevel` projects for a lazy tree level. */
export interface FolderTreeRow {
  id: string;
  parentFolderId: string | null;
  name: string;
  position: string;
  hasChildren: boolean;
}

/** A folder tree-level row → wire DTO (Story MOTIR-5308 · MOTIR-5314). */
export function toFolderTreeRowDto(row: FolderTreeRow): FolderTreeRowDto {
  return {
    kind: 'folder',
    id: row.id,
    parentId: null,
    parentFolderId: row.parentFolderId,
    name: row.name,
    position: row.position,
    hasChildren: row.hasChildren,
  };
}
