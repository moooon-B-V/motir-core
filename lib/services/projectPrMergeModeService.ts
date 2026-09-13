import type { PrMergeMode, Prisma } from '@/generated/prisma/client';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { PR_MERGE_MODE_VALUES, type PrMergeModeValue } from '@/lib/dto/projects';
import { InvalidPrMergeModeError, ProjectNotFoundError } from '@/lib/projects/errors';
import { derivePrMergeModeDefault, isEstablishedSet } from '@/lib/projects/prMergeModeDefault';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';

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
//
// THE READ AND THE WRITE (MOTIR-5179), for the settings room (MOTIR-5181).
// Authority is split the way the room is: anyone who may BROWSE the project may
// READ its merge mode — so a member who may not change it arrives, sees the
// state, and meets no 403 — and changing it takes `workflow:manage`, the key
// the Approvals room's other switch already asserts
// (`approvalGateSettingsService`). A merge policy decides when work may move,
// exactly as a status graph and the acceptance-video gate do.

export const projectPrMergeModeService = {
  /** The project's merge mode, for anyone who may browse the project. */
  async getPrMergeMode(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<{ prMergeMode: PrMergeModeValue }> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const row = await withSystemContext((tx) => projectRepository.findPrMergeMode(projectId, tx));
    if (!row) throw new ProjectNotFoundError(projectId);
    return { prMergeMode: row.prMergeMode };
  },

  /**
   * Change the project's merge mode — a person's DECISION, so it is stamped, and
   * the establishment default will never overwrite it. Gated on
   * `workflow:manage` here rather than trusting a surface's guard.
   */
  async setPrMergeMode(
    projectId: string,
    mode: unknown,
    ctx: ServiceContext,
  ): Promise<{ prMergeMode: PrMergeModeValue }> {
    if (!PR_MERGE_MODE_VALUES.includes(mode as PrMergeModeValue)) {
      throw new InvalidPrMergeModeError(mode);
    }
    await projectAccessService.assertPermission(projectId, ctx, 'workflow:manage');
    const updated = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) => projectRepository.setPrMergeMode(projectId, mode as PrMergeMode, new Date(), tx),
    );
    return { prMergeMode: updated.prMergeMode };
  },

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
