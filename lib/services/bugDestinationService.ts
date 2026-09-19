import type { Folder, Prisma } from '@/generated/prisma/client';
import type { BugDestinationDto, BugDestinationFolderDto } from '@/lib/dto/projects';
import { FolderNotFoundError } from '@/lib/folders/errors';
import { DEFAULT_BUG_FOLDER_NAME } from '@/lib/projects/bugDestination';
import { InvalidBugDestinationError, ProjectNotFoundError } from '@/lib/projects/errors';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// The BUG DESTINATION resolver — Story MOTIR-4927 · Subtask MOTIR-4937.
//
// ONE answer to "where does a bug go in this project when the caller did not
// say?", read by every filer that has that case. The answer is the project's
// stored pointer (MOTIR-4934):
//
//   · a folder id → file the bug into that folder;
//   · `null`      → file it at the project ROOT, unplaced — a choice, not a gap.
//
// There is no fallback branch and no reason code, deliberately. The pointer is
// a `NoAction` foreign key that `foldersService.deleteFolder` carries up before
// deleting the folder it names (MOTIR-5537), so it always names a folder that
// exists or deliberately names none. And it is never resolved by the folder's
// NAME: `DEFAULT_BUG_FOLDER_NAME` is a label (`lib/projects/bugDestination.ts`).
//
// It takes `tx` so a filer reads the destination inside the transaction that
// creates the bug, under the same workspace binding.
//
// THE ROOM'S READ AND WRITE (MOTIR-4938) — `Project settings → Bugs`
// (`design/projects/design-notes.md` § Bugs). BOTH assert `project:administer`,
// the key the room's registry entry gates on (§4: there is no `bug:*` key, and a
// filing destination belongs to no existing domain). The write names a folder id
// or `null`; a folder that is missing or belongs to ANOTHER project is
// `FolderNotFoundError`, the folder routes' no-leak refusal, checked here before
// the database's same-project trigger would refuse it less legibly. Both return
// the room's whole view, so the room renders the write's own response.

export interface BugDestination {
  /** The folder to file into, or `null` for the project root. */
  folderId: string | null;
}

async function toDestinationFolder(
  folder: Folder,
  tx: Prisma.TransactionClient,
): Promise<BugDestinationFolderDto> {
  return {
    id: folder.id,
    name: folder.name,
    path: await folderRepository.findPathNames(folder.id, tx),
  };
}

const isBugsFolderName = (name: string) =>
  name.toLowerCase() === DEFAULT_BUG_FOLDER_NAME.toLowerCase();

async function readView(
  projectId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<BugDestinationDto> {
  const project = await projectRepository.findById(projectId, tx);
  if (!project) throw new ProjectNotFoundError(projectId);
  const pointed = project.bugDestinationFolderId
    ? await folderRepository.findById(project.bugDestinationFolderId, tx)
    : null;
  const folder = pointed ? await toDestinationFolder(pointed, tx) : null;
  if (pointed && folder && isBugsFolderName(pointed.name)) return { folder, bugsFolder: folder };
  const root = await folderRepository.findRootByName(
    projectId,
    workspaceId,
    DEFAULT_BUG_FOLDER_NAME,
    tx,
  );
  return { folder, bugsFolder: root ? await toDestinationFolder(root, tx) : null };
}

export const bugDestinationService = {
  async resolve(projectId: string, tx: Prisma.TransactionClient): Promise<BugDestination> {
    const project = await projectRepository.findById(projectId, tx);
    return { folderId: project?.bugDestinationFolderId ?? null };
  },

  /**
   * Where a PLANNER bug goes — the `@planner-bug-home` marker's answer (Story
   * MOTIR-5818 · MOTIR-5822). A LADDER, and every rung is a legal answer, so
   * filing never fails for want of a destination:
   *
   *   1. the project's planner-bug destination (`plannerBugDestinationFolderId`);
   *   2. unset ⇒ wherever PRODUCT bugs go (`bugDestinationFolderId`);
   *   3. that unset too ⇒ the project root.
   *
   * Rung 2 is a real fallback, unlike `resolve` above, because `null` means
   * something different on each pointer: on the product pointer it is *the root,
   * chosen*; on this one it is *not set, use the product answer*. Neither
   * pointer can dangle — `foldersService.deleteFolder` carries both up
   * (MOTIR-5821) — so no rung is reached because a folder vanished.
   */
  async resolvePlannerBug(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<BugDestination> {
    const project = await projectRepository.findById(projectId, tx);
    return {
      folderId: project?.plannerBugDestinationFolderId ?? project?.bugDestinationFolderId ?? null,
    };
  },

  /** The Bugs room's view of the destination, for someone who may administer the project. */
  async getSettings(projectId: string, ctx: ServiceContext): Promise<BugDestinationDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'project:administer');
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) => readView(projectId, ctx.workspaceId, tx),
    );
  },

  /**
   * Point the project's destination at one of ITS folders, or at the project
   * root with `null`. Changing it moves no bug that is already filed.
   */
  async setDestination(
    projectId: string,
    folderId: unknown,
    ctx: ServiceContext,
  ): Promise<BugDestinationDto> {
    if (folderId !== null && (typeof folderId !== 'string' || folderId.length === 0)) {
      throw new InvalidBugDestinationError(folderId);
    }
    await projectAccessService.assertPermission(projectId, ctx, 'project:administer');
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        if (folderId !== null) {
          const folder = await folderRepository.findById(folderId, tx);
          if (!folder || folder.projectId !== projectId) throw new FolderNotFoundError(folderId);
        }
        await projectRepository.setBugDestinationFolder(projectId, folderId, tx);
        return readView(projectId, ctx.workspaceId, tx);
      },
    );
  },
};
