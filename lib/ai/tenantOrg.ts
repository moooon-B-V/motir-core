import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { withOrgContext } from '@/lib/organizations/context';

// Resolve the org half of a job-submit tenant (Subtask 7.2.16) — the
// `organizationId` (the billing entity) plus its TWO org-level billing flags,
// read from the one org row:
//
//   • `isMeta` (`Organization.isMeta` — moooon B.V.), which motir-ai's credit
//     gate uses to bypass the out-of-credits paywall for the internal dogfood
//     org. Unchanged in meaning and in every consumer.
//   • `internalBilling` (MOTIR-4565), which means the opposite thing and is why
//     it is a SECOND field rather than a widened first: motir-ai pairs every
//     debit such an org incurs with an offsetting credit in the same
//     transaction, so it is charged exactly like a customer and made whole
//     (`docs/decisions/internal-billing-classification.md` §1–§2). It suppresses
//     nothing and bypasses nothing. Shared by every AI dispatch entry point
// (aiJobsService / aiChatService / aiExplanationService) so the resolution lives
// in one place.
//
// Two RLS-scoped reads: the workspace's org id under `withWorkspaceContext` (the
// workspace policy admits the row), then the org's `isMeta` under `withOrgContext`
// (the org RLS policy keys off `app.organization_id`, which the workspace context
// does NOT bind — the same seam billingService.getAiAccess uses). A missing org
// row defaults BOTH flags to false, which is the safe reading in both
// directions: an unresolvable org is not the meta org, and it is not one Motir
// makes whole either — the second default is what keeps an absent row from
// silently acquiring an offset it never earned.
export async function resolveTenantOrg(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<{ organizationId: string; isMeta: boolean; internalBilling: boolean }> {
  const organizationId = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      const workspace = await workspaceRepository.findByIdInTx(ctx.workspaceId, tx);
      if (!workspace) throw new Error(`workspace ${ctx.workspaceId} not found`);
      return workspace.organizationId;
    },
  );
  const org = await withOrgContext({ userId: ctx.userId, organizationId }, (tx) =>
    organizationRepository.findByIdInTx(organizationId, tx),
  );
  return {
    organizationId,
    isMeta: org?.isMeta ?? false,
    internalBilling: org?.internalBilling ?? false,
  };
}
