'use server';

import { requirePlatformStaff } from '@/lib/platform/auth';
import { parseSpendPeriod } from '@/lib/platform/spend';
import { platformOrgPageService } from '@/lib/services/platformOrgPageService';

/**
 * The by-workspace table's EXPAND (MOTIR-7293): one workspace's projects for the
 * period. Gated, audited once, and refused for a workspace outside the org
 * (`platformOrgPageService.getWorkspaceProjectsSpend`). `null` is motir-ai unreachable.
 */
export async function loadWorkspaceProjects(input: {
  orgId: string;
  workspaceId: string;
  period: string;
}) {
  const principal = await requirePlatformStaff('support');
  return platformOrgPageService.getWorkspaceProjectsSpend(
    principal,
    input.orgId,
    input.workspaceId,
    parseSpendPeriod(input.period),
  );
}
