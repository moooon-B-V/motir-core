// Scrum-board E2E seed helper (Story 4.5 · the closing test Subtask 4.5.4).
//
// The board routes are ACTIVE-PROJECT scoped, so this fixture mints its own
// tenant — a sign-in-able owner + workspace + project PINNED active — then
// seeds the sprint + issues entirely through the SHIPPED services (the one
// sanctioned cross-layer reach for E2E setup, exactly as
// `sprint-lifecycle-seed.ts` and `backlog-seed.ts` do). No raw inserts: every
// issue rides `backlogService.createBacklogIssue` (real `backlog_rank` +
// revision), and the sprint is started through `sprintsService.startSprint` —
// the REAL 4.4 activation path, which also provisions the project's `scrum`
// board ("the board opens") and stamps the scope-lock baseline. The fixture
// sets sprint state through the lifecycle, not by poking columns.
//
// The seeded shape the board-scrum spec drives:
//   • an ACTIVE sprint "Sprint Alpha" (goal + a future end date) holding three
//     estimated issues — A (3 pts, todo), B (2 pts, transitioned to done so the
//     completed/remaining aggregates are non-trivial), C (5 pts, todo) —
//     committed 10 / completed 2 / remaining 8;
//   • one OUT-OF-SPRINT issue (no `sprintId`) that must appear on the default
//     Kanban board but never on the sprint-scoped scrum board.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Satisfies the credential-strength rule (same shape as the sibling seeds').
export const SCRUM_SEED_PASSWORD = 'board-scrum-e2e-pass-9';

export const SCRUM_SPRINT_NAME = 'Sprint Alpha';
export const SCRUM_SPRINT_GOAL = 'Ship the scrum board end-to-end';

export interface SeededIssue {
  id: string;
  identifier: string;
  title: string;
}

export interface ScrumSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  ctx: ServiceContext;
  /** The ACTIVE sprint the scrum board renders. */
  sprintId: string;
  /** The provisioned scrum board (`type: 'scrum'`, NOT the project default). */
  scrumBoardId: string;
  /** In-sprint, estimated: A (3 pts, todo) · B (2 pts, done) · C (5 pts, todo). */
  issueA: SeededIssue;
  issueB: SeededIssue;
  issueC: SeededIssue;
  /** NOT in the sprint — visible on the Kanban board, absent from the scrum board. */
  outOfSprint: SeededIssue;
}

async function makeTenant(email: string): Promise<{ ctx: ServiceContext; projectId: string }> {
  const owner = await usersService.createUser({
    email,
    password: SCRUM_SEED_PASSWORD,
    name: 'Scrum Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Scrum board E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Scrum board',
    identifier: 'SCB',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active so the active-project-scoped /boards route resolves
  // it on sign-in (the same pin sprint-lifecycle-seed.ts does).
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
  sprintId?: string,
  points?: number,
): Promise<SeededIssue> {
  const dto = await backlogService.createBacklogIssue(
    projectId,
    { kind: 'story', title, ...(sprintId ? { sprintId } : {}) },
    ctx,
  );
  if (points !== undefined) {
    // Estimate directly so the points aggregates read as numbers, not "—". The
    // estimation write path is the sibling Story 4.3's concern; here we only
    // need the column populated — the same shortcut sprint-lifecycle-seed takes.
    await db.workItem.update({ where: { id: dto.id }, data: { storyPoints: points } });
  }
  return { id: dto.id, identifier: dto.identifier, title };
}

/**
 * Seed the scrum-board fixture: one tenant whose project has an ACTIVE sprint
 * (started through the real 4.4 lifecycle, which provisions the scrum board)
 * holding three estimated issues — one transitioned to done — plus one
 * out-of-sprint issue the sprint scope must hide.
 */
export async function seedScrumBoard(email: string): Promise<ScrumSeed> {
  const { ctx, projectId } = await makeTenant(email);

  const sprint = await sprintsService.createSprint(
    projectId,
    { name: SCRUM_SPRINT_NAME, goal: SCRUM_SPRINT_GOAL },
    ctx,
  );

  const issueA = await addIssue(ctx, projectId, 'Scrum issue A', sprint.id, 3);
  const issueB = await addIssue(ctx, projectId, 'Scrum issue B', sprint.id, 2);
  const issueC = await addIssue(ctx, projectId, 'Scrum issue C', sprint.id, 5);
  const outOfSprint = await addIssue(ctx, projectId, 'Backlog-only issue');

  // START the sprint through the shipped 4.4 path: flips it active, stamps the
  // committed baseline, and provisions the project's `scrum` board. A 5-day
  // window keeps "N days remaining" (not "Ended") on screen for the header test.
  await sprintsService.startSprint(
    sprint.id,
    { endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() },
    ctx,
  );

  // B walks the gated workflow to done (todo → in_progress → in_review → done,
  // the defaultWorkflow.ts legal path), so the header's completed/remaining
  // aggregates are non-trivial: 10 / 2 / 8.
  await workItemsService.updateStatus(issueB.id, 'in_progress', ctx);
  await workItemsService.updateStatus(issueB.id, 'in_review', ctx);
  await workItemsService.updateStatus(issueB.id, 'done', ctx);

  const boards = await boardsService.listBoards(projectId, ctx);
  const scrumBoard = boards.find((b) => b.type === 'scrum');
  if (!scrumBoard) throw new Error('startSprint should have provisioned a scrum board');

  return {
    email,
    password: SCRUM_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    ctx,
    sprintId: sprint.id,
    scrumBoardId: scrumBoard.id,
    issueA,
    issueB,
    issueC,
    outOfSprint,
  };
}
