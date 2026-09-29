import { withWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError, ReviewAgentNeedsManualMergeError } from '@/lib/projects/errors';
import type {
  ApprovalGateSettingsDTO,
  UpdateApprovalGateSettingsInput,
} from '@/lib/dto/approvalGateSettings';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * The project's APPROVAL-GATE switches (Story MOTIR-4925 · Subtask MOTIR-5170) —
 * which gates `Project settings ▸ Approvals` raises. Read by that room; written
 * by `PATCH /api/projects/[key]/approval-gates`.
 *
 * ⚠️ THIS SERVICE DOES NOT DECIDE ELIGIBILITY, AND MUST NOT LEARN TO.
 * `acceptanceVideoEligibilityService` is the ONE place the feature's verdict is
 * computed — `hasPaidAiPlan` (the organisation's) AND this switch (the
 * project's). This service owns the SETTING: reading it for the room and writing
 * it when an admin flips it. A second computation of the AND here is exactly the
 * divergence that service's header exists to prevent, and it would be invisible:
 * both would return a boolean and only one would be right.
 *
 * ⚠️ AND THE WRITE AUTHORITY IS THE DESTINATION'S, NOT THE ORIGIN'S
 * (`docs/decisions/organization-tier.md` §6). The switch used to be an org
 * column written behind `assertOrgAdmin`; moving the surface does not carry that
 * gate along with it. The key here is **`workflow:manage`** — the shipped key for
 * *may you configure how work moves through this project* — because a status
 * graph and an approval gate are the two things that decide when work may move.
 * A dedicated `gate:manage` is a reasonable later split and is deliberately NOT
 * made here: this card has no warrant to add a permission to the catalog.
 */
/** The room's switches, read off the project row — one mapping for every return. */
function toSettingsDTO(project: {
  acceptanceVideoEnabled: boolean;
  reviewAgentEnabled: boolean;
}): ApprovalGateSettingsDTO {
  return {
    acceptanceVideoEnabled: project.acceptanceVideoEnabled,
    reviewAgentEnabled: project.reviewAgentEnabled,
  };
}

export const approvalGateSettingsService = {
  /**
   * The room's read. Resolution runs under `withSystemContext` and the ACCESS
   * decision is the permission assert below it — the same order
   * `boardsService.ensureDefaultBoard` uses, and for the same reason: a
   * tenant-bound read would answer "may this actor SEE the project?", which is a
   * different question from "may this actor configure it?", and would make a
   * missing row and a denied row indistinguishable.
   *
   * ⚠️ MANAGE-ONLY: the READ takes the WRITE's key (2026-09-13 ·
   * `design/projects/design-notes.md` § ⭐ Approvals §6 · MOTIR-5394). MOTIR-5278
   * had opened this read on `project:browse` for a read-only member view. That
   * view is withdrawn, so nobody below `workflow:manage` has a reason to read.
   */
  async getSettings(projectId: string, ctx: ServiceContext): Promise<ApprovalGateSettingsDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'workflow:manage');

    const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
    if (!project) throw new ProjectNotFoundError(projectId);

    return toSettingsDTO(project);
  },

  /**
   * Flip one or more of this project's gate switches. Re-gated here rather than
   * trusting the page's own guard: hiding a rail row is presentation, and the
   * route behind it is one typed URL away (`_guard.tsx`'s own header).
   */
  async updateSettings(
    projectId: string,
    patch: UpdateApprovalGateSettingsInput,
    ctx: ServiceContext,
  ): Promise<ApprovalGateSettingsDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'workflow:manage');

    // An empty patch is a no-op READ rather than an error: the route forwards only
    // the keys the body carried, and a caller sending none has asked for nothing.
    // Returning the current state keeps the client's reconcile honest either way.
    // Only the switches the patch carries are written, so a PATCH naming one switch
    // leaves every other exactly as it was.
    const data: UpdateApprovalGateSettingsInput = {};
    if (patch.acceptanceVideoEnabled !== undefined) {
      data.acceptanceVideoEnabled = patch.acceptanceVideoEnabled;
    }
    if (patch.reviewAgentEnabled !== undefined) data.reviewAgentEnabled = patch.reviewAgentEnabled;
    if (Object.keys(data).length === 0) {
      const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
      if (!project) throw new ProjectNotFoundError(projectId);
      return toSettingsDTO(project);
    }

    const updated = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // ⚠️ THE REVIEW AGENT NEEDS A PROJECT THAT ASKS BEFORE MERGING (§12.2a). The
        // merge mode is read under the project's row lock — the lock the merge-mode
        // write takes too — so the two switches cannot be turned into the forbidden
        // pair by two admins at once.
        if (data.reviewAgentEnabled === true) {
          await projectRepository.lockById(projectId, tx);
          const mode = await projectRepository.findPrMergeMode(projectId, tx);
          if (!mode) throw new ProjectNotFoundError(projectId);
          if (mode.prMergeMode === 'auto') throw new ReviewAgentNeedsManualMergeError(projectId);
        }
        return projectRepository.updateApprovalGateSettings(projectId, data, tx);
      },
    );

    return toSettingsDTO(updated);
  },
};
