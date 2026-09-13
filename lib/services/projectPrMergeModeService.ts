import type { PrMergeMode, Prisma } from '@/generated/prisma/client';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { derivePrMergeModeDefault, isEstablishedSet } from '@/lib/projects/prMergeModeDefault';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';

// A project's MERGE MODE (Story MOTIR-4880, `docs/decisions/approval-gates.md` §7
// and its 2026-09-13 amendment).
//
// THE ESTABLISHMENT DEFAULT (MOTIR-5178). `Project.prMergeMode` is created at the
// `manual` FLOOR, because a project row exists before it has repositories. The
// provenance default is written here, the first time the project's repository set
// is ESTABLISHED, and ONCE: only where `prMergeModeDecidedAt` is still null. So
// re-establishing, adding a hosted repository to a `manual` project, or removing
// a row and settling the set again never re-derives a value somebody holds.
//
// WHERE IT IS CALLED. Inside the transaction of every seam that settles a row or
// appends a settled one — `projectRepoSetService.transitionRow`,
// `attachRealizedRepoRow` and `removeRow`, and `organizationRepoService`'s
// `linkExistingRepo` / `connectAndLink`. Inside, not post-commit: the seed and the
// row write that made the set established commit together, so no crash can leave
// an established set undecided.
//
// ⚠️ IT LOCKS THE PROJECT ROW BEFORE IT READS THE SET. Two rows of one set settling
// concurrently would otherwise each read the other as still unsettled, both decide
// the set is not established, and the default would never be written. Under the
// project lock the second transaction waits for the first to commit, and its set
// read (READ COMMITTED, a fresh statement) then sees the first row settled. Lock
// order is always row-then-project, so the two cannot deadlock.

export const projectPrMergeModeService = {
  /**
   * Write the provenance default if the set has just become established and the
   * value is undecided. Returns the mode written, or null when nothing was
   * written (not established, or already decided).
   *
   * Takes the caller's `tx`: it is a step of the caller's transaction, never its
   * own. `hostOwner` defaults to the server's provisioning org.
   */
  async seedAtEstablishment(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
    hostOwner: string | null = provisioningOrgLogin(),
  ): Promise<PrMergeMode | null> {
    const locked = await projectRepository.lockById(projectId, tx);
    if (!locked) return null;
    const current = await projectRepository.findPrMergeMode(projectId, tx);
    if (!current || current.prMergeModeDecidedAt !== null) return null;

    const rows = await projectRepoRepository.listByProject(projectId, workspaceId, tx);
    if (!isEstablishedSet(rows)) return null;

    const mode = derivePrMergeModeDefault(rows, hostOwner);
    const written = await projectRepository.seedPrMergeModeIfUndecided(
      projectId,
      mode,
      new Date(),
      tx,
    );
    return written === 1 ? mode : null;
  },
};
