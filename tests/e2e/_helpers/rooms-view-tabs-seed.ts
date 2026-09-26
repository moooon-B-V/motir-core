import { adminDb } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { plansService } from '@/lib/services/plansService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// Seed for Story MOTIR-6179's E2E + acceptance recording (Subtask MOTIR-6337):
// the Plans, Approvals and Runs rooms, each holding records of the MEMBER's and
// of other people's, walked by a Viewer, a Member and a custom role.
//
// ⚠️ THE PERSONAS ARE PROJECT ROLES ON PLAIN WORKSPACE MEMBERS, never the
// workspace owner, who rides the always-pass rail and would hold every key —
// the trap `permission-gated-ui-seed.ts` names. The OWNER is only the author of
// "somebody else's" records.
//
// THE COUNTS THE SPEC ASSERTS, and why each is what it is:
//
//   · Plans — 3 conversations: 1 started by the Member, 2 by the owner.
//   · Runs  — 3 runs: 1 started by the Member (scoped to the story), 2 by the
//     owner (one scoped to the same story, one unscoped).
//   · Approvals — 3 records, NONE the Member's: 2 awaiting the owner, 1 decided
//     by the owner. So the Member's Mine view of Approvals is EMPTY — the story's
//     "one room's Mine is empty" case — and a two-view reader whose Mine is empty
//     lands on Project (design MOTIR-6327's default rule).

export const ROOMS_PASSWORD = 'rooms-view-tabs-e2e-pass-123';
export const ROOMS_PROJECT_KEY = 'RVT';

export const ROOMS_COUNTS = {
  plans: { project: 3, member: 1 },
  runs: { project: 3, member: 1, memberInStory: 1 },
  approvals: { project: 3, member: 0 },
} as const;

export interface RoomsViewTabsSeed {
  viewerEmail: string;
  memberEmail: string;
  /** A CUSTOM role: browse + the Plans and Approvals view keys; NO run key, NO `work_item:edit`. */
  customEmail: string;
  password: string;
  storyKey: string;
  memberPlanTitle: string;
  ownerPlanTitles: string[];
}

export async function seedRoomsViewTabs(slug: string): Promise<RoomsViewTabsSeed> {
  const owner = await usersService.createUser({
    email: `rvt-owner-${slug}@example.com`,
    password: ROOMS_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Rooms Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Rooms Project',
    identifier: ROOMS_PROJECT_KEY,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const membership = { key: project.identifier, actorUserId: owner.id, ctx: ownerCtx };

  async function pin(userId: string) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  async function persona(label: string, name: string): Promise<string> {
    const user = await usersService.createUser({
      email: `rvt-${label}-${slug}@example.com`,
      password: ROOMS_PASSWORD,
      name,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    return user.id;
  }

  const viewerId = await persona('viewer', 'Vera Viewer');
  await projectMembersService.addMember({ ...membership, targetUserId: viewerId, role: 'viewer' });
  const memberId = await persona('member', 'Milo Member');
  await projectMembersService.addMember({ ...membership, targetUserId: memberId, role: 'member' });

  // The CUSTOM role, through the shipped custom-role path (the Manager's Roles &
  // permissions door writes through this service). It reads Plans and Approvals
  // and can neither see Runs nor start one: no `run:view_any`, no `work_item:edit`.
  const role = await projectRoleDefinitionService.create({
    projectId: project.id,
    ctx: ownerCtx,
    name: 'Plans and approvals reader',
    permissions: ['project:browse', 'plan:view_any', 'approval:view_any'],
  });
  const customId = await persona('custom', 'Cato Custom');
  await projectMembersService.addMember({ ...membership, targetUserId: customId, role: 'member' });
  await projectMembersService.setRole({ ...membership, targetUserId: customId, role: role.id });

  for (const id of [owner.id, viewerId, memberId, customId]) await pin(id);
  const memberCtx = { userId: memberId, workspaceId: workspace.id };

  // ── The work the runs and approvals are about ──────────────────────────────
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Invoices export to CSV' },
    ownerCtx,
  );
  const cards: string[] = [];
  const cardIds: string[] = [];
  for (const title of ['Draw the export button', 'Write the CSV encoder', 'Wire the download']) {
    const card = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'subtask',
        parentId: story.id,
        title,
        type: 'design',
        assigneeId: owner.id,
      },
      ownerCtx,
    );
    cards.push(card.identifier);
    cardIds.push(card.id);
  }

  // ── Plans: one conversation the Member started, two the owner did ──────────
  const memberPlanTitle = 'Milo’s plan for the export';
  const ownerPlanTitles = ['Olivia’s billing plan', 'Olivia’s onboarding plan'];
  await plansService.createPlan(
    project.id,
    {
      title: memberPlanTitle,
      session: { origin: 'mcp' },
      authorSource: 'mcp',
      createdById: memberId,
    },
    memberCtx,
  );
  for (const title of ownerPlanTitles) {
    await plansService.createPlan(
      project.id,
      { title, session: { origin: 'mcp' }, authorSource: 'mcp', createdById: owner.id },
      ownerCtx,
    );
  }

  // ── Runs: one the Member started (scoped to the story), two the owner did ──
  async function run(ctx: typeof ownerCtx, key: string, scoped: boolean) {
    await dispatchRunService.open(
      {
        projectKey: project.identifier,
        command: 'batch',
        ...(scoped ? { scopeKey: story.identifier } : {}),
        cards: [{ key, disposition: 'queued' as const }],
      },
      ctx,
    );
  }
  await run(ownerCtx, cards[0]!, true);
  await run(ownerCtx, cards[1]!, false);
  await run(memberCtx, cards[2]!, true);

  // ── Approvals: three records, none of them the Member's ────────────────────
  for (const [i, workItemId] of cardIds.entries()) {
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        workItemId,
        kind: 'design_result',
        subjectId: `rvt-evidence-${workItemId}`,
        routedToId: owner.id,
        createdAt: new Date(Date.now() - (3 - i) * 3_600_000),
      },
    });
    if (i === 0) {
      await adminDb.approvalGate.update({
        where: { id: gate.id },
        data: {
          state: 'approved',
          decidedById: owner.id,
          decidedAt: new Date(Date.now() - 1_800_000),
          decidedByLabel: `${owner.name} <${owner.email}>`,
          subjectVersion: 'c0ffee15beef',
        },
      });
    }
  }

  return {
    viewerEmail: `rvt-viewer-${slug}@example.com`,
    memberEmail: `rvt-member-${slug}@example.com`,
    customEmail: `rvt-custom-${slug}@example.com`,
    password: ROOMS_PASSWORD,
    storyKey: story.identifier,
    memberPlanTitle,
    ownerPlanTitles,
  };
}
