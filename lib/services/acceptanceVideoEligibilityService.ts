import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { withSystemContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { billingService } from '@/lib/services/billingService';
import type { AcceptanceVideoEligibilityDTO } from '@/lib/dto/acceptanceVideoEligibility';

/**
 * Story-acceptance-video eligibility (Story MOTIR-1627 · Subtask MOTIR-1630).
 * The ONE place the ADR decision-1 rule is computed — feature eligibility =
 * `hasPaidAiPlan` (Axis A, from billingService) AND the gate switch ON — so the
 * acceptance panel, the publish endpoint, and the settings card never diverge.
 * READ-ONLY: the per-upload cost bound (`assertWithinStorageCap`) is enforced
 * separately on the write path (acceptanceEvidenceService, MOTIR-1629).
 *
 * ⚠️ THE TWO HALVES OF THE AND ARE SCOPED TO DIFFERENT TIERS, ON PURPOSE
 * (MOTIR-4925 · MOTIR-5168, `docs/decisions/acceptance-video.md` §3 as amended):
 *
 *   * `hasPaidAiPlan` is the ORGANISATION's. The plan is bought once, for the
 *     account, and nothing here changes that.
 *   * the SWITCH is the PROJECT's. Whether a finished story owes a receipt is a
 *     question about how a team works, and every other work-process setting is
 *     already `projectId`-scoped.
 *
 * So callers pass the project whose gate is being asked about — for every one of
 * them that is the STORY'S OWN project, never the actor's current one.
 */
export const acceptanceVideoEligibilityService = {
  async resolve(input: {
    actorUserId: string;
    workspaceId: string;
    /**
     * The project whose gate this verdict is about — the STORY'S own project.
     * Required: a verdict that silently fell back to an org-wide answer would be
     * indistinguishable from a correct one, which is the defect this card fixes.
     */
    projectId: string;
  }): Promise<AcceptanceVideoEligibilityDTO> {
    const access = await billingService.getAiAccessForContext({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    });

    // Off-cloud / meta org / no resolvable org → the feature is UNGATED, so it
    // is ELIGIBLE (there is no AI plan to buy and no storage to meter). The panel
    // renders the player directly — no upsell, no billing chrome. This is what
    // lets a self-hoster use acceptance video AND the moooon META org publish its
    // own self-test dogfood video (isMeta ⇒ applicable:false).
    if (!access.applicable || !access.organizationId) {
      return {
        applicable: false,
        eligible: true,
        reason: 'not_applicable',
        hasPaidAiPlan: false,
        toggleEnabled: true,
        canManageBilling: false,
        canManageToggle: false,
        organizationId: null,
      };
    }

    const organizationId = access.organizationId;
    // ⚠️ THE PROJECT ROW IS READ UNDER `withSystemContext`, AND THAT IS A
    // FAIL-CLOSED DECISION RATHER THAN A CONVENIENCE. This gate is asked by three
    // callers with three different credentials — a user session, a CI publisher
    // token, and an MCP token — and each has ALREADY authorised the story it is
    // asking about. A tenant-scoped read here would answer a different question
    // ("may this actor see the project?"), and its failure mode is the dangerous
    // direction: a denied read returns null, `?? true` opens the gate, and the
    // verdict is a plausible one nobody can tell from a correct one. So the row is
    // resolved once, unbound, exactly as `boardsService` resolves a project before
    // binding the tenant it belongs to.
    //
    // ⚠️ STILL `allSettledOrThrow`, NOT `Promise.all` — MOTIR-3077's repair, and
    // swapping WHICH row the first arm reads does not touch the reason for it.
    // `resolveOrgAccess` is an ACCESS GATE (`assertOrgMember` →
    // `OrganizationNotFoundError`) that rejects on an ORDINARY path: an actor who
    // reaches this workspace without being a member of the organisation behind it.
    // Under `Promise.all` that refusal returned immediately and left the sibling
    // arm's interactive transaction running unobserved, holding a pool connection
    // and its `AccessShareLock`s past the point the caller believed the read was
    // over — MOTIR-3066's `getQuickView` shape exactly, with the gate written
    // second instead of first. `allSettledOrThrow` awaits both arms and then
    // rethrows the first rejection in ARRAY order.
    const [project, orgAccess] = await allSettledOrThrow([
      withSystemContext((tx) => projectRepository.findById(input.projectId, tx)),
      organizationsService.resolveOrgAccess(input.actorUserId, organizationId),
    ]);

    // A project that does not resolve is not a project whose gate is off — it is a
    // caller that asked about something that is not there. `true` is the same
    // direction the org read defaulted in, and it stays safe for the same reason:
    // the entitlement above gates publication independently, so an over-open
    // switch publishes nothing without a paid plan.
    const toggleEnabled = project?.acceptanceVideoEnabled ?? true;
    const eligible = access.hasPaidAiPlan && toggleEnabled;
    const reason = !access.hasPaidAiPlan ? 'no_plan' : !toggleEnabled ? 'toggle_off' : 'eligible';

    return {
      applicable: true,
      eligible,
      reason,
      hasPaidAiPlan: access.hasPaidAiPlan,
      toggleEnabled,
      canManageBilling: access.canManageBilling,
      canManageToggle: orgAccess.isOrgAdmin,
      organizationId,
    };
  },
};
