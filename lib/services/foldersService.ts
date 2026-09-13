import type { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { toFolderDto } from '@/lib/mappers/folderMappers';
import { keyBetween, keyForAppend } from '@/lib/workItems/positioning';
import {
  CrossProjectFolderError,
  FOLDER_NAME_MAX_LENGTH,
  FolderCycleError,
  FolderNameTakenError,
  FolderNotFoundError,
  InvalidFolderNameError,
  SubtaskNeedsPlacementError,
} from '@/lib/folders/errors';
import type {
  CreateFolderInput,
  DeleteFolderInput,
  DeleteFolderResultDto,
  FileWorkItemInput,
  FileWorkItemResultDto,
  FolderDto,
  MoveFolderInput,
  RenameFolderInput,
} from '@/lib/dto/folders';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Folder service (Epic MOTIR-5307 · Story MOTIR-5308 · MOTIR-5313) — every rule
// about folders, so the tree, the item page, the API, the MCP and the planner
// all ask one place and never disagree about what is allowed. No route and no
// Server Action lives here (CLAUDE.md's 4-layer contract).
//
// ── THE CONTRACTS THIS FILE HOLDS ─────────────────────────────────────────
//
// 1. EVERY METHOD IS `work_item:edit` ON THE PROJECT, AND THE GATE COMES FIRST.
//    Each method names its project, so the gate runs before a single folder row
//    is read: a member without edit rights learns nothing about a folder by
//    being refused on it, not even whether it exists.
//
// 2. DELETING A FOLDER MOVES ITS CONTENTS UP, IN THE SAME TRANSACTION. Motir has
//    no trash and deleting a work item is irreversible, so a folder is a place,
//    and removing a place never removes what was stored there. Two cases refuse
//    the delete rather than lose or mangle anything, both typed:
//      * a child folder whose name collides with a folder already at the
//        destination (the sibling-name rule holds everywhere);
//      * a ROOT folder holding a subtask with no work-item parent — at the root
//        it would have neither a parent nor a folder, which the kind rule forbids.
//
// 3. A STRUCTURAL CHANGE IS SERIALIZED PER PROJECT. Moves and deletes take
//    `folderRepository.lockStructure` first (its comment says why row locks
//    cannot see a cycle), then the rows. Creates and renames change no chain and
//    take only the row lock they need; the unique index backstops their race.
//
// 4. FILING A WORK ITEM LIVES IN `workItemsService`. Filing an item that has a
//    work-item parent is a re-parent to the root, so it owes the same container
//    rollup and child-set event `moveWorkItem` emits, and those helpers are that
//    service's. `fileWorkItem` below is the folder-domain door onto it.

function normalizeFolderName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new InvalidFolderNameError('empty', 0);
  if (name.length > FOLDER_NAME_MAX_LENGTH)
    throw new InvalidFolderNameError('too_long', name.length);
  return name;
}

/**
 * Lock and resolve a folder that must belong to `projectId`. A folder that does
 * not exist, is invisible, or lives in another project is NOT FOUND: the caller
 * addressed it through this project, and in this project it does not exist.
 */
async function lockFolderInProject(
  folderId: string,
  projectId: string,
  tx: Prisma.TransactionClient,
) {
  const locked = await folderRepository.lockById(folderId, tx);
  if (!locked || locked.projectId !== projectId) throw new FolderNotFoundError(folderId);
  const folder = await folderRepository.findById(folderId, tx);
  /* istanbul ignore next -- defensive: the row was locked in this transaction, so it cannot vanish before this read */
  if (!folder) throw new FolderNotFoundError(folderId);
  return folder;
}

/**
 * Resolve a DESTINATION folder for an operation in `projectId`. Unlike the
 * folder being acted on, a destination in another project is a named mistake
 * (`CrossProjectFolderError`), not a missing row.
 */
async function lockDestination(
  folderId: string,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const locked = await folderRepository.lockById(folderId, tx);
  if (!locked) throw new FolderNotFoundError(folderId);
  if (locked.projectId !== projectId) throw new CrossProjectFolderError();
}

export const foldersService = {
  async createFolder(input: CreateFolderInput, ctx: ServiceContext): Promise<FolderDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      await projectAccessService.assertCanEdit(input.projectId, ctx, tx);
      const name = normalizeFolderName(input.name);
      if (input.parentFolderId !== null) {
        // The lock also stops a concurrent delete removing the parent between
        // this check and the insert.
        await lockDestination(input.parentFolderId, input.projectId, tx);
      }
      const clash = await folderRepository.findSiblingNameConflict(
        { projectId: input.projectId, parentFolderId: input.parentFolderId, name },
        tx,
      );
      if (clash) throw new FolderNameTakenError(name);
      const last = await folderRepository.lastSiblingPosition(
        input.projectId,
        input.parentFolderId,
        tx,
      );
      const row = await folderRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId: input.projectId,
          parentFolderId: input.parentFolderId,
          name,
          position: keyForAppend(last),
          createdById: ctx.userId,
        },
        tx,
      );
      return toFolderDto(row);
    });
  },

  async renameFolder(input: RenameFolderInput, ctx: ServiceContext): Promise<FolderDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      await projectAccessService.assertCanEdit(input.projectId, ctx, tx);
      const name = normalizeFolderName(input.name);
      const folder = await lockFolderInProject(input.folderId, input.projectId, tx);
      if (folder.name === name) return toFolderDto(folder);
      const clash = await folderRepository.findSiblingNameConflict(
        {
          projectId: folder.projectId,
          parentFolderId: folder.parentFolderId,
          name,
          excludeId: folder.id,
        },
        tx,
      );
      if (clash) throw new FolderNameTakenError(name);
      return toFolderDto(await folderRepository.rename(folder.id, name, tx));
    });
  },

  /**
   * Move a folder into another folder or to the root, reorder it among its
   * siblings, or both. Reordering is a move to the same parent with neighbours.
   */
  async moveFolder(input: MoveFolderInput, ctx: ServiceContext): Promise<FolderDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      await projectAccessService.assertCanEdit(input.projectId, ctx, tx);
      await folderRepository.lockStructure(input.projectId, tx);
      const folder = await lockFolderInProject(input.folderId, input.projectId, tx);
      const target = input.targetParentFolderId;

      if (target !== null) {
        if (target === folder.id) throw new FolderCycleError();
        await lockDestination(target, input.projectId, tx);
        // Under the structure lock, so no concurrent move can change this chain
        // between the read and the write.
        const chain = await folderRepository.findAncestorIds(target, tx);
        if (chain.includes(folder.id)) throw new FolderCycleError();
      }

      const parentChanged = target !== folder.parentFolderId;
      if (parentChanged) {
        const clash = await folderRepository.findSiblingNameConflict(
          {
            projectId: folder.projectId,
            parentFolderId: target,
            name: folder.name,
            excludeId: folder.id,
          },
          tx,
        );
        if (clash) throw new FolderNameTakenError(folder.name);
      }

      const neighbourPosition = async (id: string | null | undefined): Promise<string | null> => {
        if (id === null || id === undefined) return null;
        const neighbour = await folderRepository.findById(id, tx);
        if (!neighbour || neighbour.projectId !== input.projectId)
          throw new FolderNotFoundError(id);
        return neighbour.position;
      };

      let position: string;
      if (input.beforeId == null && input.afterId == null) {
        position = parentChanged
          ? keyForAppend(await folderRepository.lastSiblingPosition(input.projectId, target, tx))
          : folder.position;
      } else {
        position = keyBetween(
          await neighbourPosition(input.beforeId),
          await neighbourPosition(input.afterId),
        );
      }

      if (!parentChanged && position === folder.position) return toFolderDto(folder);
      return toFolderDto(
        await folderRepository.move(folder.id, { parentFolderId: target, position }, tx),
      );
    });
  },

  /**
   * Delete a folder, moving its child folders and filed work items to its own
   * parent (or the root) first. Nothing inside it is removed.
   */
  async deleteFolder(
    input: DeleteFolderInput,
    ctx: ServiceContext,
  ): Promise<DeleteFolderResultDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      await projectAccessService.assertCanEdit(input.projectId, ctx, tx);
      await folderRepository.lockStructure(input.projectId, tx);
      const folder = await lockFolderInProject(input.folderId, input.projectId, tx);
      const destination = folder.parentFolderId;

      const childFolders = await folderRepository.findChildFolders(folder.id, tx);
      const filed = await workItemRepository.findFiledInFolder(folder.id, tx);

      // Refuse BEFORE the first write, so a refused delete changes nothing.
      if (destination === null) {
        const unplaced = filed.filter((item) => item.kind === 'subtask' && item.parentId === null);
        if (unplaced.length > 0) throw new SubtaskNeedsPlacementError(unplaced.map((i) => i.id));
      }
      let childSharesParentName = false;
      for (const child of childFolders) {
        if (child.name.toLowerCase() === folder.name.toLowerCase()) {
          childSharesParentName = true;
          continue;
        }
        const clash = await folderRepository.findSiblingNameConflict(
          {
            projectId: folder.projectId,
            parentFolderId: destination,
            name: child.name,
            excludeId: child.id,
          },
          tx,
        );
        if (clash) throw new FolderNameTakenError(child.name);
      }

      // A child named like the folder being deleted would collide with it at
      // the destination until the delete lands, and the delete cannot land
      // while the child still points at it. Parking the doomed folder under its
      // own id — unique, and gone by the end of this transaction — lets the
      // child take the name it is keeping.
      if (childSharesParentName) await folderRepository.rename(folder.id, folder.id, tx);

      let lastFolderPosition = await folderRepository.lastSiblingPosition(
        folder.projectId,
        destination,
        tx,
      );
      for (const child of childFolders) {
        lastFolderPosition = keyForAppend(lastFolderPosition);
        await folderRepository.move(
          child.id,
          { parentFolderId: destination, position: lastFolderPosition },
          tx,
        );
      }

      let lastItemPosition = await workItemRepository.findLastPositionAtFolderLevel(
        folder.projectId,
        destination,
        tx,
      );
      for (const item of filed) {
        lastItemPosition = keyForAppend(lastItemPosition);
        await workItemRepository.update(
          item.id,
          { folderId: destination, position: lastItemPosition },
          tx,
        );
        await workItemRevisionsService.recordRevision(
          {
            workItemId: item.id,
            changedById: ctx.userId,
            changeKind: 'updated',
            diff: {
              folderId: { from: folder.id, to: destination },
              position: { from: item.position, to: lastItemPosition },
            },
          },
          tx,
        );
      }

      await folderRepository.delete(folder.id, tx);
      return {
        deletedFolderId: folder.id,
        destinationFolderId: destination,
        movedFolderIds: childFolders.map((c) => c.id),
        movedWorkItemIds: filed.map((i) => i.id),
      };
    });
  },

  /**
   * File a work item into a folder (clearing its work-item parent), or take it
   * out of its folder. The item's subtree comes with it: only its own placement
   * changes. See contract 4 above for why this delegates.
   */
  async fileWorkItem(
    workItemId: string,
    input: FileWorkItemInput,
    ctx: ServiceContext,
  ): Promise<FileWorkItemResultDto> {
    return workItemsService.fileWorkItem(workItemId, input, ctx);
  },
};
