import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';

// MOTIR-5549 — a story SHAPED BY SIX PLANS, seeded through the product's own
// plan doors (create → append → mark planned → approve / decline), so every
// relation the item page's plan history reads was written by `materialize` and
// the decision paths, never by a hand-rolled row.
//
// The six, in creation order, and the sentence each must render on the story:
//
//   A  approved  `add` that CREATED the story      → "Created this item"
//   B  approved  `modify` of the story             → "Changed this item"
//   C  declined  3 `add`s parented on the story    → "Proposed 3 work items under this item — not added"
//   D  declined  `modify` of the story             → "Proposed changes to this item — not applied"
//   E  declined  `remove` of the story             → "Proposed to archive this item — not applied"
//   F  planned   1 `add` parented on the story     → "Proposes 1 work item under this item"
//
// Six because the section shows the OLDEST FIVE (design § Plan history 6), so
// F is the one plan Show more plans has to reach.
//
// Plus: a story no plan touched (the no-section case), and a VIEWER — the
// built-in role holding `project:browse` + `report:view` and NOT `ai:view_plan`
// (`lib/permissions/builtinRoles.ts`), so the page skips the read for them.

export const PLAN_HISTORY_PASSWORD = 'plan-history-e2e-pass-5549';
const PROJECT_KEY = 'PHS';

export interface SeededPlan {
  id: string;
  title: string;
}

export interface PlanHistorySeed {
  ownerEmail: string;
  viewerEmail: string;
  story: { id: string; identifier: string };
  untouched: { identifier: string };
  plans: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f', SeededPlan>;
}

export async function seedPlanHistory(slug: string): Promise<PlanHistorySeed> {
  const ownerEmail = `plan-history-owner-${slug}@example.com`;
  const viewerEmail = `plan-history-viewer-${slug}@example.com`;

  const owner = await usersService.createUser({
    email: ownerEmail,
    password: PLAN_HISTORY_PASSWORD,
    name: 'Hana Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Plan History E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Plan History',
    identifier: PROJECT_KEY,
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  const pin = (userId: string) =>
    db.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  await pin(owner.id);

  const viewer = await usersService.createUser({
    email: viewerEmail,
    password: PLAN_HISTORY_PASSWORD,
    name: 'Vic Viewer',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: workspace.id });
  await db.projectMembership.create({
    data: { userId: viewer.id, projectId: project.id, workspaceId: workspace.id, role: 'viewer' },
  });
  await pin(viewer.id);

  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'Customer onboarding' },
    ctx,
  );
  const untouched = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Account recovery', parentId: epic.id },
    ctx,
  );

  // A — creates the story. Its id is the one `materialize` writes back onto the
  // `add`, which is exactly the row the history's "created it" arm reads.
  const a = await plansService.createPlan(project.id, { title: 'Plan the onboarding story' }, ctx);
  await plansService.addProposals(
    a.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Onboarding checklist', kind: 'story' },
        parentRef: epic.id,
      },
    ],
    ctx,
  );
  await plansService.markPlanned(a.id, ctx);
  const approvedA = await plansService.approvePlan(a.id, ctx);
  const storyId = approvedA.items.find((item) => item.op === 'add')?.workItemId;
  if (!storyId) throw new Error('plan A did not materialize its story');
  const storyRow = await db.workItem.findUniqueOrThrow({ where: { id: storyId } });
  const story = { id: storyId, identifier: `${PROJECT_KEY}-${storyRow.key}` };

  const decide = async (
    title: string,
    proposals: Parameters<typeof plansService.addProposals>[1],
    outcome: 'approve' | 'decline' | 'leave-planned',
  ): Promise<SeededPlan> => {
    const plan = await plansService.createPlan(project.id, { title }, ctx);
    await plansService.addProposals(plan.id, proposals, ctx);
    await plansService.markPlanned(plan.id, ctx);
    if (outcome === 'approve') await plansService.approvePlan(plan.id, ctx);
    if (outcome === 'decline') await plansService.declinePlan(plan.id, ctx);
    return { id: plan.id, title };
  };

  const b = await decide(
    'Tighten the onboarding copy',
    [
      {
        op: 'modify',
        workItemId: story.id,
        patch: { title: 'Onboarding checklist with progress' },
      },
    ],
    'approve',
  );
  const c = await decide(
    'Split onboarding into steps',
    ['Verify email', 'Pick a workspace', 'Invite a teammate'].map((stepTitle) => ({
      op: 'add' as const,
      proposedFields: { title: stepTitle, kind: 'subtask' as const },
      parentRef: story.id,
    })),
    'decline',
  );
  const d = await decide(
    'Rename onboarding to getting started',
    [{ op: 'modify', workItemId: story.id, patch: { title: 'Getting started' } }],
    'decline',
  );
  const e = await decide(
    'Fold onboarding into account setup',
    [{ op: 'remove', workItemId: story.id }],
    'decline',
  );
  const f = await decide(
    'Add a welcome email',
    [
      {
        op: 'add',
        proposedFields: { title: 'Send the welcome email', kind: 'subtask' },
        parentRef: story.id,
      },
    ],
    'leave-planned',
  );

  return {
    ownerEmail,
    viewerEmail,
    story,
    untouched: { identifier: untouched.identifier },
    plans: { a: { id: a.id, title: 'Plan the onboarding story' }, b, c, d, e, f },
  };
}
