import { withOrgContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { billingService } from '@/lib/services/billingService';
import type { AcceptanceVideoEligibilityDTO } from '@/lib/dto/acceptanceVideoEligibility';

/**
 * Story-acceptance-video eligibility (Story MOTIR-1627 · Subtask MOTIR-1630).
 * The ONE place the ADR decision-1 rule is computed — feature eligibility =
 * `hasPaidAiPlan` (Axis A, from billingService) AND the org toggle ON — so the
 * acceptance panel, the publish endpoint, and the settings card never diverge.
 * READ-ONLY: the per-upload cost bound (`assertWithinStorageCap`) is enforced
 * separately on the write path (acceptanceEvidenceService, MOTIR-1629).
 */
export const acceptanceVideoEligibilityService = {
  async resolve(input: {
    actorUserId: string;
    workspaceId: string;
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
    const [org, orgAccess] = await Promise.all([
      withOrgContext({ userId: input.actorUserId, organizationId }, (tx) =>
        organizationRepository.findByIdInTx(organizationId, tx),
      ),
      organizationsService.resolveOrgAccess(input.actorUserId, organizationId),
    ]);

    const toggleEnabled = org?.acceptanceVideoEnabled ?? true;
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
