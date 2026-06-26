// Roadmap E2E seed (Subtask 7.20.8 / MOTIR-1015).
//
// The project Roadmap view (Story 7.20 · MOTIR-1011) is ACTIVE-PROJECT scoped —
// `/roadmap` resolves `getActiveProject()` — so each fixture mints its own tenant
// (a sign-in-able owner + workspace + project, the project PINNED active) and
// seeds the tree entirely through the SHIPPED services (the one sanctioned
// cross-layer reach for E2E setup, exactly as `plans-review-seed.ts` /
// `backlog-seed.ts` do). No raw inserts: every node rides
// `workItemsService.createWorkItem`, and every status rides
// `workItemsService.updateStatus` along the LEGAL workflow path (todo →
// in_progress → in_review → done — there is no direct todo→done edge).
//
// The populated tree is shaped to exercise the roadmap markers (MOTIR-1013):
//   • Epic "Platform foundation" is moved IN PROGRESS → it is the root level's
//     in-progress frontier, so the canvas marks it "you are here".
//   • It has two child stories (one DONE, one to-do) → it is drillable AND
//     renders a subtree progress meter; drilling it reveals those children.
//   • A second epic "Growth experiments" gives the road a sibling at root, so
//     "drill in then back" is observable (the sibling is hidden while drilled,
//     visible again at root).

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Satisfies the credential-strength rule (same shape as the other seeds').
export const ROADMAP_SEED_PASSWORD = 'roadmap-view-e2e-pass-7';

export interface RoadmapSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** The in-progress epic — the "you are here" frontier; drill target. */
  activeEpicTitle: string;
  /** The other root epic — visible at root, hidden while drilled into the active epic. */
  otherEpicTitle: string;
  /** The active epic's two children (revealed on drill). */
  doneChildTitle: string;
  todoChildTitle: string;
}

async function makeTenant(
  email: string,
  workspaceName: string,
  projectName: string,
  identifier: string,
): Promise<{ ctx: ServiceContext; projectId: string; projectKey: string }> {
  const owner = await usersService.createUser({
    email,
    password: ROADMAP_SEED_PASSWORD,
    name: 'Roadmap Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: workspaceName,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: projectName,
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active for the owner so the active-project-scoped /roadmap
  // route resolves it on sign-in (the same pin plans-review-seed does for /plans).
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
  };
}

// Walk an item all the way to Done along the only legal path (the default
// workflow has no direct todo→done edge — see `_shared.md` / defaultWorkflow).
async function moveToDone(id: string, ctx: ServiceContext): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', ctx);
  await workItemsService.updateStatus(id, 'in_review', ctx);
  await workItemsService.updateStatus(id, 'done', ctx);
}

/** The main fixture: a populated roadmap with an in-progress (drillable) epic
 *  carrying the "you are here" marker + a progress meter, and a sibling epic.
 *
 *  `onboarded` (default true) stamps the immutable onboarding-ran marker
 *  (Subtask 7.4 / MOTIR-1264) so the roadmap shows the planning-origin cluster —
 *  the project's tree "came from" an approved plan. Pass `false` for a
 *  never-onboarded project (an existing tree with no materialized plan, like a
 *  db:seed tenant): same tree, but the marker is null so BOTH onboarding gates
 *  flip — `/onboarding` renders instead of redirecting, and the roadmap omits the
 *  planning-origin cluster. */
export async function seedRoadmap(
  email: string,
  opts: { onboarded?: boolean } = {},
): Promise<RoadmapSeed> {
  const { onboarded = true } = opts;
  const { ctx, projectId, projectKey } = await makeTenant(email, 'Roadmap E2E', 'Roadmap', 'ROAD');

  // The active epic — created first so it is the root level's first item, and
  // moved IN PROGRESS so it becomes the "you are here" frontier.
  const activeEpicTitle = 'Platform foundation';
  const activeEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: activeEpicTitle },
    ctx,
  );
  await workItemsService.updateStatus(activeEpic.id, 'in_progress', ctx);

  // Two children → the epic is drillable and shows a subtree progress meter
  // (one done, one to-do = a partial bar).
  const doneChildTitle = 'Authentication';
  const doneChild = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: doneChildTitle, parentId: activeEpic.id },
    ctx,
  );
  await moveToDone(doneChild.id, ctx);

  const todoChildTitle = 'Billing';
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: todoChildTitle, parentId: activeEpic.id },
    ctx,
  );

  // A second root epic (with a child so it is itself drillable) — the sibling
  // that disappears while drilled and returns on "Back".
  const otherEpicTitle = 'Growth experiments';
  const otherEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: otherEpicTitle },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Referrals', parentId: otherEpic.id },
    ctx,
  );

  // Stamp (or leave null) the immutable onboarding-ran marker — the single
  // source of truth both onboarding gates read (Subtask 7.4 / MOTIR-1264). An
  // onboarded project shows the planning-origin cluster + redirects away from
  // /onboarding; a never-onboarded one omits the cluster + still enters
  // onboarding. Raw db write, matching this seed's membership-pin approach.
  if (onboarded) {
    await db.project.update({ where: { id: projectId }, data: { onboardingRanAt: new Date() } });
  }

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    projectKey,
    activeEpicTitle,
    otherEpicTitle,
    doneChildTitle,
    todoChildTitle,
  };
}

/** A tenant with a project but ZERO work items — for the empty-state branch. */
export async function seedEmptyRoadmapProject(
  email: string,
): Promise<{ email: string; password: string }> {
  await makeTenant(email, 'Roadmap E2E — empty', 'No Roadmap Yet', 'EMPT');
  return { email, password: ROADMAP_SEED_PASSWORD };
}

export interface SprintRoadmapSeed {
  email: string;
  password: string;
  projectKey: string;
  sprintName: string;
  /** Epic that CONTAINS in-sprint work — present in BOTH scopes; drill target. */
  inSprintEpicTitle: string;
  /** Epic with NO in-sprint descendants — present in project scope, PRUNED in sprint scope. */
  backlogEpicTitle: string;
  /** The in-sprint epic's child story (ancestor of the in-sprint leaf) — present on drill in sprint scope. */
  inSprintStoryTitle: string;
  /** A sibling story under the in-sprint epic with no in-sprint work — PRUNED on drill in sprint scope. */
  backlogStoryTitle: string;
}

/**
 * The SPRINT-SCOPE fixture (MOTIR-1384): a populated roadmap with an ACTIVE
 * SPRINT, shaped so project scope and sprint scope render visibly different node
 * sets. One epic CONTAINS an in-sprint leaf (so it survives the member-or-ancestor
 * prune), a sibling epic is wholly backlog (so it disappears under sprint scope),
 * and under the in-sprint epic one story is the in-sprint leaf's ancestor while a
 * sibling story is backlog (so drilling under scope prunes it too).
 *
 * Sprint membership is the flat `work_item.sprintId`; this seed sets it directly
 * (the same sanctioned direct-`db` reach the tenant pin above uses) — the
 * board/backlog move flow only adds rank bookkeeping irrelevant to a read test.
 */
export async function seedSprintRoadmap(email: string): Promise<SprintRoadmapSeed> {
  const { ctx, projectId, projectKey } = await makeTenant(
    email,
    'Roadmap E2E — sprint',
    'Sprint Roadmap',
    'SPRT',
  );

  const sprintName = 'Sprint 1';
  const sprint = await db.sprint.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId,
      name: sprintName,
      state: 'active',
      sequence: 1,
    },
  });

  // Epic that contains in-sprint work.
  const inSprintEpicTitle = 'Platform foundation';
  const inSprintEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: inSprintEpicTitle },
    ctx,
  );
  await workItemsService.updateStatus(inSprintEpic.id, 'in_progress', ctx);

  // Its in-sprint branch: Story → an IN-SPRINT subtask leaf.
  const inSprintStoryTitle = 'Authentication';
  const inSprintStory = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: inSprintStoryTitle, parentId: inSprintEpic.id },
    ctx,
  );
  const inSprintLeaf = await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', title: 'Login flow', parentId: inSprintStory.id },
    ctx,
  );
  await db.workItem.update({ where: { id: inSprintLeaf.id }, data: { sprintId: sprint.id } });

  // A sibling story under the same epic with NO in-sprint descendants.
  const backlogStoryTitle = 'Billing';
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: backlogStoryTitle, parentId: inSprintEpic.id },
    ctx,
  );

  // A second epic that is wholly backlog (no in-sprint descendant) → pruned in sprint scope.
  const backlogEpicTitle = 'Growth experiments';
  const backlogEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: backlogEpicTitle },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Referrals', parentId: backlogEpic.id },
    ctx,
  );

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    projectKey,
    sprintName,
    inSprintEpicTitle,
    backlogEpicTitle,
    inSprintStoryTitle,
    backlogStoryTitle,
  };
}
