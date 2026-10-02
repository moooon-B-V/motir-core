import type { Page } from '@/generated/prisma/client';
import type { PageDto } from '@/lib/dto/pages';
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
