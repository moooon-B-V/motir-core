import { adminDb } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// The fixture of the workspace-roles acceptance walk (Story MOTIR-6168 ·
// MOTIR-6468).
//
// ONE organization holding TWO workspaces, so the workspace tier is REVEALED and
// `/settings/workspace` is a place of its own (`organization-tier.md` §6d):
//
//   * Northwind — the walk's workspace: Maya (the org Owner, so a Manager),
//     Theo (a Member the walk demotes to Viewer) and Rae (a Member the walk puts
//     on the Reviewer role it authors). Two projects, Payments and Growth, each
//     with a card; Payments also holds a plan, a run and an approval record that
//     MAYA made, so a reader sees them only through the rooms' Project tab.
//   * Sales — a second workspace with nobody changed by the migration, for the
//     "an empty report shows no notice" state.
//
// The migration REPORT is seeded straight into `role_migration_report`: the E2E
// database is migrated empty, so the mapping has no legacy rows to report on.
// It is this app's own table, so seeding it is the honest route (the card's
// Tier note).

export const WR_PASSWORD = 'workspace-roles-e2e-pass-123';
export const PAYMENTS_KEY = 'PAY';
export const GROWTH_KEY = 'GRO';

export interface WorkspaceRolesSeed {
  organizationId: string;
  managerEmail: string;
  memberEmail: string;
  reviewerEmail: string;
  memberName: string;
  reviewerName: string;
  workspaceId: string;
  salesWorkspaceId: string;
  paymentsItemKey: string;
  paymentsItemTitle: string;
  growthItemKey: string;
  growthItemTitle: string;
  planTitle: string;
  /** The report rows, in the notice's order (newest first). */
  report: { name: string; reasonText: string }[];
}

export async function seedWorkspaceRoles(slug: string): Promise<WorkspaceRolesSeed> {
  const email = (label: string) => `wr-${label}-${slug}@example.com`;
  const person = (label: string, name: string) =>
    usersService.createUser({ email: email(label), password: WR_PASSWORD, name });

  const maya = await person('manager', 'Maya Manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Northwind',
    ownerUserId: maya.id,
  });
  // ⚠️ THE FREE PLAN CAPS AN ORGANIZATION AT ONE WORKSPACE, and the acceptance
  // lane is cloud-on — the one-field remedy `acceptance-org-roles.spec.ts` uses:
  // a paid AI plan bundles a seat, which resolves the org to the uncapped tier.
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { aiIncludedSeat: true },
  });
  const { workspace: sales } = await workspacesService.createWorkspace({
    name: 'Sales',
    ownerUserId: maya.id,
    organizationId: workspace.organizationId,
  });

  const theo = await person('member', 'Theo Teammate');
  const rae = await person('reviewer', 'Rae Reviewer');
  for (const u of [theo, rae]) {
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
  }

  const mayaCtx = { userId: maya.id, workspaceId: workspace.id };
  const payments = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: maya.id,
    name: 'Payments',
    identifier: PAYMENTS_KEY,
  });
  const growth = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: maya.id,
    name: 'Growth',
    identifier: GROWTH_KEY,
  });

  const paymentsItemTitle = 'Retry failed card captures';
  const growthItemTitle = 'Draft the referral email';
  const paymentsItem = await workItemsService.createWorkItem(
    { projectId: payments.id, kind: 'task', title: paymentsItemTitle },
    mayaCtx,
  );
  const growthItem = await workItemsService.createWorkItem(
    { projectId: growth.id, kind: 'task', title: growthItemTitle },
    mayaCtx,
  );

  // Records Maya made in Payments — another person reads them only through a
  // room's Project tab, which is what a view-any key opens.
  const planTitle = 'Maya’s plan for card retries';
  await plansService.createPlan(
    payments.id,
    { title: planTitle, session: { origin: 'mcp' }, authorSource: 'mcp', createdById: maya.id },
    mayaCtx,
  );
  await dispatchRunService.open(
    {
      projectKey: payments.identifier,
      command: 'batch',
      cards: [{ key: paymentsItem.identifier, disposition: 'queued' as const }],
    },
    mayaCtx,
  );
  await adminDb.approvalGate.create({
    data: {
      workspaceId: workspace.id,
      projectId: payments.id,
      workItemId: paymentsItem.id,
      kind: 'design_result',
      subjectId: `wr-evidence-${paymentsItem.id}`,
      routedToId: maya.id,
    },
  });

  // Everyone lands in Northwind / Payments (the earliest membership is the
  // fallback workspace, and Northwind was created first).
  for (const id of [maya.id, theo.id, rae.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: id, workspaceId: workspace.id } },
      data: { activeProjectId: payments.id },
    });
    await adminDb.user.update({
      where: { id },
      data: { lastActiveProjectId: payments.id },
    });
  }

  // The migration report: what the mapping would have written for Theo and Rae.
  const t0 = Date.now() - 60_000;
  await adminDb.roleMigrationReport.create({
    data: {
      workspaceId: workspace.id,
      userId: rae.id,
      beforeJson: {
        workspaceRole: 'member',
        projects: [{ projectKey: GROWTH_KEY, role: 'admin' }],
      },
      afterRole: 'member',
      reason: 'project_role_dropped',
      createdAt: new Date(t0),
    },
  });
  await adminDb.roleMigrationReport.create({
    data: {
      workspaceId: workspace.id,
      userId: theo.id,
      beforeJson: {
        workspaceRole: 'member',
        projects: [{ projectKey: PAYMENTS_KEY, role: 'viewer' }],
      },
      afterRole: 'viewer',
      reason: 'narrowest_kept',
      createdAt: new Date(t0 + 1_000),
    },
  });

  return {
    organizationId: workspace.organizationId,
    managerEmail: email('manager'),
    memberEmail: email('member'),
    reviewerEmail: email('reviewer'),
    memberName: 'Theo Teammate',
    reviewerName: 'Rae Reviewer',
    workspaceId: workspace.id,
    salesWorkspaceId: sales.id,
    paymentsItemKey: paymentsItem.identifier,
    paymentsItemTitle,
    growthItemKey: growthItem.identifier,
    growthItemTitle,
    planTitle,
    report: [
      {
        name: 'Theo Teammate',
        reasonText: 'Held a narrower role in a project — the narrowest was kept.',
      },
      {
        name: 'Rae Reviewer',
        reasonText: 'A project role wider than the workspace role was dropped.',
      },
    ],
  };
}
