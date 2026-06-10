// Sprint-lifecycle E2E seed helper (Story 4.4 · the closing test Subtask 4.4.7).
//
// The lifecycle surface is ACTIVE-PROJECT scoped (the `/backlog` route resolves
// `getActiveProject()`), so this fixture mints its own tenant — a sign-in-able
// owner + workspace + project PINNED active — then seeds the sprints + issues it
// needs entirely through the SHIPPED services (the one sanctioned cross-layer
// reach for E2E setup, exactly as `backlog-seed.ts` and `work-item-setup.ts` do).
// No raw inserts: every issue rides `backlogService.createBacklogIssue`, so it
// gets a real `backlog_rank` and a 1.4.6 revision, the same path the product uses.
//
// The fixture lays out the three planned sprints the focused lifecycle journey
// exercises:
//   • main  — a planned sprint with three estimated issues. The journey starts
//             it, marks one issue done, then completes it carrying the two
//             unfinished issues back to the backlog and renders the report.
//   • empty — a planned sprint with ZERO issues, so the Start button stays
//             disabled (the 4.2.1 rule).
//   • second— a planned sprint with one issue, used to prove the up-front
//             "already active" guard once `main` is running.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Satisfies the credential-strength rule (same shape as backlog-seed's).
export const LIFECYCLE_SEED_PASSWORD = 'sprint-lifecycle-e2e-pass-9';

export interface SeededIssue {
  id: string;
  identifier: string;
  title: string;
}

export interface LifecycleSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  /** The planned sprint the journey starts + completes. */
  mainSprintId: string;
  mainSprintName: string;
  /** main's three committed issues, in rank order (a, b, c). */
  mainIssues: SeededIssue[];
  /** A planned sprint with no issues — its Start button stays disabled. */
  emptySprintId: string;
  emptySprintName: string;
  /** A second planned sprint (one issue) — proves the already-active guard. */
  secondSprintId: string;
  secondSprintName: string;
}

async function makeTenant(email: string): Promise<{ ctx: ServiceContext; projectId: string }> {
  const owner = await usersService.createUser({
    email,
    password: LIFECYCLE_SEED_PASSWORD,
    name: 'Lifecycle Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Sprint lifecycle E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Lifecycle',
    identifier: 'LFC',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active so the active-project-scoped /backlog route resolves
  // it on sign-in (the same pin backlog-seed.ts / seed-large.ts do).
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: owner.id, workspaceId: workspace.id }, projectId: project.id };
}

async function addIssue(
  ctx: ServiceContext,
  projectId: string,
  title: string,
  sprintId: string,
  points?: number,
): Promise<SeededIssue> {
  const dto = await backlogService.createBacklogIssue(
    projectId,
    { kind: 'story', title, sprintId },
    ctx,
  );
  if (points !== undefined) {
    // Estimate directly so the committed/completed points read as numbers, not
    // "—". The estimation write path is a sibling Story 4.3 concern; here we only
    // need the column populated, the same shortcut the integration tests take.
    await db.workItem.update({ where: { id: dto.id }, data: { storyPoints: points } });
  }
  return { id: dto.id, identifier: dto.identifier, title };
}

/** Seed the lifecycle fixture: a startable main sprint + an empty sprint + a
 *  second sprint, all planned, in one active-pinned project. */
export async function seedSprintLifecycle(email: string): Promise<LifecycleSeed> {
  const { ctx, projectId } = await makeTenant(email);

  const mainSprintName = 'Lifecycle Alpha';
  const main = await sprintsService.createSprint(
    projectId,
    { name: mainSprintName, goal: 'Ship the sprint lifecycle' },
    ctx,
  );
  const mainIssues = [
    await addIssue(ctx, projectId, 'Lifecycle issue A', main.id, 3),
    await addIssue(ctx, projectId, 'Lifecycle issue B', main.id, 2),
    await addIssue(ctx, projectId, 'Lifecycle issue C', main.id, 5),
  ];

  const emptySprintName = 'Lifecycle Empty';
  const empty = await sprintsService.createSprint(projectId, { name: emptySprintName }, ctx);

  const secondSprintName = 'Lifecycle Beta';
  const second = await sprintsService.createSprint(projectId, { name: secondSprintName }, ctx);
  await addIssue(ctx, projectId, 'Beta issue', second.id);

  return {
    email,
    password: LIFECYCLE_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    projectName: 'Lifecycle',
    mainSprintId: main.id,
    mainSprintName,
    mainIssues,
    emptySprintId: empty.id,
    emptySprintName,
    secondSprintId: second.id,
    secondSprintName,
  };
}
