import type { Page } from '@/generated/prisma/client';
import type {
  PageDto,
  PageListItemDto,
  PageMoveResultDto,
  PageParentDto,
  PageTrailDto,
  PageTreeRowDto,
} from '@/lib/dto/pages';
import type { FolderTreeRow } from '@/lib/mappers/folderMappers';
import type { LockedPageRow, PageRow } from '@/lib/pages';

// Page rows ↔ `@motir/pages`' port rows (Story MOTIR-5752 · MOTIR-7276).
//
// The package speaks `Uint8Array` and plain rows; Prisma speaks its `Page`
// model and, for the raw `FOR UPDATE` read, the column names `$queryRaw`
// returns. These two functions are the whole translation, so the adapter only
// maps and the repository only queries.

/** A page read without its body — every column the port's `PageRow` carries. */
export type PageRecord = Omit<Page, 'bodyState' | 'bodyJson' | 'bodyMarkdown' | 'bodyText'>;

/** The raw `SELECT … FOR UPDATE` row `pageRepository.lockById` returns. */
export interface PageLockedRecord extends PageRecord {
  bodyState: Uint8Array;
}

/**
 * The columns `findById` selects — everything but the body, which a plain read
 * never needs and which is up to 2 MiB.
 */
export const PAGE_RECORD_SELECT = {
  id: true,
  workspaceId: true,
  projectId: true,
  title: true,
  parentPageId: true,
  folderId: true,
  position: true,
  ancestorPageIds: true,
  revision: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function toPageRow(record: PageRecord): PageRow {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    title: record.title,
    parentPageId: record.parentPageId,
    folderId: record.folderId,
    position: record.position,
    ancestorPageIds: [...record.ancestorPageIds],
    revision: record.revision,
    createdById: record.createdById,
    updatedById: record.updatedById,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** The locked row, its `bytea` body as a plain `Uint8Array` (pg hands back a `Buffer`). */
export function toLockedPageRow(record: PageLockedRecord): LockedPageRow {
  const body = record.bodyState;
  return {
    ...toPageRow(record),
    bodyState: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
  };
}

/**
 * The raw row `pageRepository.findLevelAfter` returns (MOTIR-7369): one page of
 * a tree level, no body, with whether it holds any sub-page.
 */
export interface PageLevelRecord {
  id: string;
  title: string;
  position: string;
  updatedAt: Date;
  hasChildren: boolean;
}

/**
 * One page of a `/pages` tree level, as the page service composes the level
 * (MOTIR-7370): what the row renders, and the `(position, id)` the keyset cursor
 * pages on.
 */
export interface PageLevelRow {
  readonly id: string;
  readonly title: string;
  readonly position: string;
  readonly updatedAt: Date;
  readonly hasChildren: boolean;
}

export function toPageLevelRow(record: PageLevelRecord): PageLevelRow {
  return {
    id: record.id,
    title: record.title,
    position: record.position,
    updatedAt: record.updatedAt,
    hasChildren: Boolean(record.hasChildren),
  };
}

/**
 * The page as the read model returns it (MOTIR-7277): the canonical state as
 * base64 — the editor's seed, from which it derives everything else — and
 * whether THIS caller may write it.
 */
export function toPageDto(row: LockedPageRow, canEdit: boolean): PageDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    revision: row.revision,
    bodyState: Buffer.from(
      row.bodyState.buffer,
      row.bodyState.byteOffset,
      row.bodyState.byteLength,
    ).toString('base64'),
    updatedAt: row.updatedAt.toISOString(),
    canEdit,
  };
}

/**
 * One `/pages` index row (MOTIR-7300): the page and the display name of whoever
 * edited it last, resolved by the service from `updatedById`. `updated_by_id`
 * is a `Restrict` foreign key, so the editor always exists; `''` only covers a
 * user row the batch read did not return.
 */
export function toPageListItemDto(
  record: Pick<Page, 'id' | 'title' | 'updatedAt' | 'updatedById'>,
  editorName: string | undefined,
): PageListItemDto {
  return {
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt.toISOString(),
    updatedBy: { id: record.updatedById, name: editorName ?? '' },
  };
}

// ── The page tree (Story MOTIR-5753 · MOTIR-7370) ──────────────────────────

/** A folder of a `/pages` tree level (`folderRepository.findLevelForPages`) → wire row. */
export function toPageTreeFolderRowDto(row: FolderTreeRow): PageTreeRowDto {
  return { kind: 'folder', id: row.id, name: row.name, hasChildren: Boolean(row.hasChildren) };
}

/** A page of a `/pages` tree level → wire row. */
export function toPageTreePageRowDto(row: PageLevelRow): PageTreeRowDto {
  return { kind: 'page', id: row.id, title: row.title, hasChildren: row.hasChildren };
}

/** A page's parent from its two placement columns (`page_parent_xor_folder`: at most one is set). */
export function toPageParentDto(row: Pick<PageRow, 'parentPageId' | 'folderId'>): PageParentDto {
  if (row.parentPageId !== null) return { kind: 'page', id: row.parentPageId };
  if (row.folderId !== null) return { kind: 'folder', id: row.folderId };
  return { kind: 'root' };
}

/** Where a move left the page. */
export function toPageMoveResultDto(row: PageRow, moved: boolean): PageMoveResultDto {
  return {
    id: row.id,
    parent: toPageParentDto(row),
    position: row.position,
    ancestorPageIds: [...row.ancestorPageIds],
    moved,
  };
}

/** A page's breadcrumb: its folder chain and its ancestor pages, each root-first. */
export function toPageTrailDto(
  folders: ReadonlyArray<{ id: string; name: string }>,
  pages: ReadonlyArray<{ id: string; title: string }>,
): PageTrailDto {
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    pages: pages.map((p) => ({ id: p.id, title: p.title })),
  };
}
