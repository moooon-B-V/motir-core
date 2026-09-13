import { withWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
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
 * gate along with it. The WRITE key here is **`workflow:manage`** — the shipped
 * key for *may you configure how work moves through this project* — because a
 * status graph and an approval gate are the two things that decide when work may
 * move. A dedicated `gate:manage` is a reasonable later split and is deliberately
 * NOT made here: this card has no warrant to add a permission to the catalog.
 *
 * ⚠️ THE TWO VERBS TAKE TWO KEYS (Task MOTIR-5278). The READ is
 * **`project:browse`**: the room is shown read-only to a member who cannot manage
 * it (`design/projects/design-notes.md` § ⭐ Approvals §6, decided on MOTIR-5190),
 * and a door that admits them onto a read that throws is a crash, not a room. The
 * registry entry `approvals` declares the same pair, and
 * `tests/settings/projectSettingsNav.test.ts` reads `getSettings` below for the
 * view key — re-gate this read on the write key and that test fails.
 */
export const approvalGateSettingsService = {
  /**
   * The room's read, open to every project BROWSER (MOTIR-5278). Resolution runs
   * under `withSystemContext` and the ACCESS decision is the permission assert
   * below it — the same order `boardsService.ensureDefaultBoard` uses, so a
   * missing row and a denied row stay distinguishable.
   *
   * The 404-vs-403 posture does not move with the key: `assertPermission` answers
   * a non-browser with `ProjectNotFoundError` before any key is consulted, so an
   * actor who cannot see the project still cannot learn this room exists.
   */
  async getSettings(projectId: string, ctx: ServiceContext): Promise<ApprovalGateSettingsDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'project:browse');

    const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
    if (!project) throw new ProjectNotFoundError(projectId);

    return { acceptanceVideoEnabled: project.acceptanceVideoEnabled };
  },

  /**
   * Flip one or more of this project's gate switches — the WRITE, which keeps
   * `workflow:manage`. Re-gated here rather than trusting the page: the room now
   * ADMITS actors who may not change it, so the page disabling its switch is
   * presentation and this assert is the refusal (`_guard.tsx`'s own header).
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
    if (patch.acceptanceVideoEnabled === undefined) {
      const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
      if (!project) throw new ProjectNotFoundError(projectId);
      return { acceptanceVideoEnabled: project.acceptanceVideoEnabled };
    }

    const updated = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        projectRepository.updateApprovalGateSettings(
          projectId,
          { acceptanceVideoEnabled: patch.acceptanceVideoEnabled },
          tx,
        ),
    );

    return { acceptanceVideoEnabled: updated.acceptanceVideoEnabled };
  },
};
