import type { Prisma } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';

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

export interface BugDestination {
  /** The folder to file into, or `null` for the project root. */
  folderId: string | null;
}

export const bugDestinationService = {
  async resolve(projectId: string, tx: Prisma.TransactionClient): Promise<BugDestination> {
    const project = await projectRepository.findById(projectId, tx);
    return { folderId: project?.bugDestinationFolderId ?? null };
  },
};
