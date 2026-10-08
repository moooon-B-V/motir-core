// The CROWDED tenant the label-fit spec measures (Story MOTIR-7730 · MOTIR-7759).
//
// Labels that only render with content — a board column's count, the sprint
// header's actions, a plan's review controls, the bell's badge, the public
// indicator — are absent from a quiet fixture, so a quiet fixture measures a
// narrower product than people use (the lesson `cloud-top-bar-budget.spec.ts`
// records). Everything is seeded through the shipped services.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

export const LABEL_FIT_PASSWORD = 'label-fit-e2e-pass-9';

/** The seeded work content, which the spec waits on to prove a surface LOADED:
 *  it is user data, so it reads the same in every locale. */
export const LABEL_FIT_TITLES = {
  todo: 'Draft the onboarding copy',
  doing: 'Wire the language control',
  review: 'Review the German catalogue',
  done: 'Ship the locale list',
  backlog: 'Groom the backlog',
} as const;
export const LABEL_FIT_SPRINT = 'Sprint 1';
export const LABEL_FIT_PLAN = 'Translate the settings';
export const LABEL_FIT_PROPOSAL = 'Settings in eleven languages';

export interface LabelFitSeed {
  email: string;
  password: string;
  /** A work item whose page is measured (it has a child, so the children tab renders). */
  itemKey: string;
  /** A plan awaiting review, so its approve / request-changes controls render. */
  planId: string;
  /** The active sprint. `/sprints` has no index page — a sprint's only route is
   *  its report, `/sprints/<id>/report`. */
  sprintId: string;
}

export async function seedLabelFitTenant(email: string): Promise<LabelFitSeed> {
  const owner = await usersService.createUser({
    email,
    password: LABEL_FIT_PASSWORD,
    name: 'Label Fit',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Label fit',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Label fit',
    identifier: 'LFT',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  // A sprint holding work, started so the sprint header's actions render.
  const sprint = await sprintsService.createSprint(
    project.id,
    { name: LABEL_FIT_SPRINT, goal: 'Every label fits' },
    ctx,
  );
  const add = async (title: string, inSprint: boolean) =>
    backlogService.createBacklogIssue(
      project.id,
      { kind: 'story', title, ...(inSprint ? { sprintId: sprint.id } : {}) },
      ctx,
    );

  // At least one work item per board column.
  const todo = await add(LABEL_FIT_TITLES.todo, true);
  const doing = await add(LABEL_FIT_TITLES.doing, true);
  const review = await add(LABEL_FIT_TITLES.review, true);
  const done = await add(LABEL_FIT_TITLES.done, true);
  await add(LABEL_FIT_TITLES.backlog, false);
  await workItemsService.updateStatus(doing.id, 'in_progress', ctx);
  await workItemsService.updateStatus(review.id, 'in_progress', ctx);
  await workItemsService.updateStatus(review.id, 'in_review', ctx);
  for (const status of ['in_progress', 'in_review', 'done'] as const) {
    await workItemsService.updateStatus(done.id, status, ctx);
  }
  await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: 'Measure the labels', parentId: todo.id },
    ctx,
  );
  await sprintsService.startSprint(
    sprint.id,
    { endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
    ctx,
  );

  // An open plan awaiting review.
  const plan = await plansService.createPlan(
    project.id,
    { title: LABEL_FIT_PLAN, createdById: owner.id },
    ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: LABEL_FIT_PROPOSAL, kind: 'task' } }],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);

  // A public project and an unread notification: the top bar's crowded state.
  await setProjectAccess(db, project.id, 'public');
  await db.notification.create({
    data: {
      workspaceId: workspace.id,
      recipientUserId: owner.id,
      type: 'work_item.mentioned',
      category: 'direct',
      data: {},
      dedupeKey: 'label-fit-unread',
    },
  });

  return {
    email,
    password: LABEL_FIT_PASSWORD,
    itemKey: todo.identifier,
    planId: plan.id,
    sprintId: sprint.id,
  };
}
