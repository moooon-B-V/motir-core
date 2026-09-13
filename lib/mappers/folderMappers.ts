import type { Folder } from '@/generated/prisma/client';
import type { FolderDto, FolderPickerNodeDto } from '@/lib/dto/folders';
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

/** The row `folderRepository.findProjectFolders` projects. */
export interface ProjectFolderRow {
  id: string;
  parentFolderId: string | null;
  name: string;
  position: string;
}

/**
 * A project's folder rows → picker options in TREE ORDER, each carrying its
 * name path (Story MOTIR-5308 · MOTIR-5343).
 *
 * `rows` arrive siblings-in-order (the repository sorts by position, name, id),
 * and every row's ancestors are among them because the read takes shallow
 * levels first. A row whose parent is somehow absent is still listed, at the
 * end with the path it has — dropping it would hide a real folder.
 */
export function toFolderPickerNodeDtos(rows: ProjectFolderRow[]): FolderPickerNodeDto[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string | null, ProjectFolderRow[]>();
  for (const row of rows) {
    const parent =
      row.parentFolderId !== null && byId.has(row.parentFolderId) ? row.parentFolderId : null;
    const key =
      row.parentFolderId === null || parent !== null ? row.parentFolderId : `orphan:${row.id}`;
    const list = children.get(key) ?? [];
    list.push(row);
    children.set(key, list);
  }

  const out: FolderPickerNodeDto[] = [];
  const visit = (row: ProjectFolderRow, parentPath: string[]) => {
    const path = [...parentPath, row.name];
    out.push({
      id: row.id,
      parentFolderId: row.parentFolderId,
      name: row.name,
      position: row.position,
      path,
    });
    for (const child of children.get(row.id) ?? []) visit(child, path);
  };
  for (const root of children.get(null) ?? []) visit(root, []);
  for (const [key, list] of children) {
    if (typeof key === 'string' && key.startsWith('orphan:'))
      for (const row of list) visit(row, []);
  }
  return out;
}
