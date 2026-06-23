import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { withOrgContext } from '@/lib/organizations/context';

// Resolve the org half of a job-submit tenant (Subtask 7.2.16) — the
// `organizationId` (the billing entity) plus its META flag (`Organization.isMeta`
// — moooon B.V.), which motir-ai's credit gate uses to bypass the out-of-credits
// paywall for the internal dogfood org. Shared by every AI dispatch entry point
// (aiJobsService / aiChatService / aiExplanationService) so the resolution lives
// in one place.
//
// Two RLS-scoped reads: the workspace's org id under `withWorkspaceContext` (the
// workspace policy admits the row), then the org's `isMeta` under `withOrgContext`
// (the org RLS policy keys off `app.organization_id`, which the workspace context
// does NOT bind — the same seam billingService.getAiAccess uses). A missing org
// row defaults `isMeta` to false (safe: the org is simply not the meta org).
export async function resolveTenantOrg(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<{ organizationId: string; isMeta: boolean }> {
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
  return { organizationId, isMeta: org?.isMeta ?? false };
}
