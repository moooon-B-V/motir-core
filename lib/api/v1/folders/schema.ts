import { z } from 'zod/v4';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import type {
  DeleteFolderResultDto,
  FolderLevelPosition,
  FolderResourceDto,
  UpdateFolderInput,
} from '@/lib/dto/folders';
import { FOLDER_NAME_MAX_LENGTH } from '@/lib/folders/errors';

// The v1 FOLDER resource (Story MOTIR-5310 · MOTIR-5408) — a named, nestable
// place in a project's tree that carries no workflow. Every folder response and
// request shape is declared HERE, beside each other, because an OpenAPI
// operation is both (the sprint module's reasoning).
//
// ── A v1 response is a SCHEMA's output, never a service DTO ──────────────────
// `presentFolder` maps field by field. `FolderResourceDto` carries
// `createdById` and `projectId`, which stay internal: a folder is addressed
// through its project's KEY on the wire, as a work item is.
//
// ── The folder id IS a cuid on the wire, and that is a DECISION ──────────────
// ADR §7's key-only rule governs work items, which have a `MOTIR-<n>` key. A
// folder has no such key — the sprint module records the identical exception —
// so its id is its name, and `parentFolderId` names a folder the same way.
//
// ── `path` is ROOT FIRST ────────────────────────────────────────────────────
// `["Parked", "2025"]` for *Parked ▸ 2025*: the folder's own name is LAST. The
// same vocabulary the quick view and the work-item placement fields speak.

const isoDateTimeSchema = z.string().datetime();

/** The v1 folder resource. */
export const folderSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  /** The folder this one sits in, or `null` at the project root. */
  parentFolderId: z.string().nullable(),
  name: z.string(),
  /** The folder's name and every ancestor's, root first. */
  path: z.array(z.string()),
  /** Fractional index among sibling folders — opaque, but it sorts. */
  position: z.string(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type V1Folder = z.infer<typeof folderSchema>;

/** Map a folder to the wire resource — field by field, never a spread. */
export function presentFolder(folder: FolderResourceDto): V1Folder {
  return {
    id: folder.id,
    projectKey: folder.projectKey,
    parentFolderId: folder.parentFolderId,
    name: folder.name,
    path: folder.path,
    position: folder.position,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

/** The `DELETE /api/v1/folders/{folderId}` body: what moved, and where. */
export const folderDeletionSchema = z.object({
  deletedFolderId: z.string(),
  /** Where the contents went — the deleted folder's parent, or `null` for the root. */
  destinationFolderId: z.string().nullable(),
  movedFolderIds: z.array(z.string()),
  movedWorkItemIds: z.array(z.string()),
});
export type V1FolderDeletion = z.infer<typeof folderDeletionSchema>;

export function presentFolderDeletion(result: DeleteFolderResultDto): V1FolderDeletion {
  return {
    deletedFolderId: result.deletedFolderId,
    destinationFolderId: result.destinationFolderId,
    movedFolderIds: result.movedFolderIds,
    movedWorkItemIds: result.movedWorkItemIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST schemas
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ The NAME rule is the service's. `normalizeFolderName` trims and caps, and
// an empty or over-long name is `INVALID_FOLDER_NAME` (422) from there — so the
// schema asserts only the wire TYPE, and the documented cap is quoted, not
// enforced a second time.

/** `POST /api/v1/projects/{projectKey}/folders`. */
export const createFolderBodySchema = z
  .object({
    name: z
      .string()
      .describe(
        `The folder's name. Trimmed; empty or over ${FOLDER_NAME_MAX_LENGTH} characters is \`INVALID_FOLDER_NAME\`.`,
      ),
    parentFolderId: z
      .string()
      .nullish()
      .describe('The folder to create it inside. Omit or `null` for the project root.'),
  })
  .strict();
export type CreateFolderBody = z.infer<typeof createFolderBodySchema>;

/**
 * `PATCH /api/v1/folders/{folderId}` — a RENAME (`name`) or a PLACEMENT
 * (`parentFolderId` / `beforeId` / `afterId`), never both. One object rather than
 * a `oneOf`, so the refusal can NAME the two groups instead of reporting
 * whichever branch a union validator happened to try last.
 */
export const updateFolderBodySchema = z
  .object({
    name: z.string().optional().describe('RENAME the folder. Not combinable with a placement.'),
    parentFolderId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'MOVE the folder into this folder, or `null` for the project root. Omit to keep its parent (a pure reorder).',
      ),
    beforeId: z
      .string()
      .nullable()
      .optional()
      .describe('Place it AFTER this sibling folder (the one that sorts before it).'),
    afterId: z
      .string()
      .nullable()
      .optional()
      .describe('Place it BEFORE this sibling folder (the one that sorts after it).'),
  })
  .strict();
export type UpdateFolderBody = z.infer<typeof updateFolderBodySchema>;

/**
 * Split a parsed PATCH body into the service's rename-OR-placement input.
 *
 * ⚠️ Both groups together is REFUSED, not sequenced: the service renames and
 * moves in two transactions, so a request that failed its move after renaming
 * would leave a half-applied change the caller never asked for. Neither group is
 * refused too — an empty PATCH is a client bug, not a no-op.
 */
export function toUpdateFolderInput(body: UpdateFolderBody): UpdateFolderInput {
  const placement = {
    ...(body.parentFolderId !== undefined ? { parentFolderId: body.parentFolderId } : {}),
    ...(body.beforeId !== undefined ? { beforeId: body.beforeId } : {}),
    ...(body.afterId !== undefined ? { afterId: body.afterId } : {}),
  };
  const placing = Object.keys(placement).length > 0;
  if (body.name !== undefined && placing) {
    throw new InvalidRequestError(
      'INVALID_REQUEST',
      'A folder PATCH renames (`name`) OR places (`parentFolderId` / `beforeId` / `afterId`) — send the two as separate requests.',
    );
  }
  if (body.name !== undefined) return { name: body.name };
  if (!placing) {
    throw new InvalidRequestError(
      'INVALID_REQUEST',
      'A folder PATCH needs a `name` to rename, or `parentFolderId` / `beforeId` / `afterId` to place it.',
    );
  }
  return placement;
}

/** `?parentFolderId=` on the list — absent or empty is the project root. */
export function readParentFolderIdParam(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get('parentFolderId');
  return raw === null || raw === '' ? null : raw;
}

/**
 * The position reader for the `folders` collection's cursor — the
 * `(position, id)` of the last row served, exactly what the keyset read seeks
 * after. Anything else is refused as a cursor this collection did not issue.
 */
export function readFolderLevelPosition(position: unknown): FolderLevelPosition | undefined {
  if (typeof position !== 'object' || position === null) return undefined;
  const { position: pos, id } = position as Record<string, unknown>;
  if (typeof pos !== 'string' || pos.length === 0) return undefined;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return { position: pos, id };
}
