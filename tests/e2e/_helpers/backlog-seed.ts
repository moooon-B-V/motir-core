// Backlog E2E seed helpers (Subtask 4.2.6 — the closing Story-4.2 test).
//
// The backlog/sprint-planning surface is ACTIVE-PROJECT scoped (the `/backlog`
// route resolves `getActiveProject()`), so each fixture mints its own tenant —
// a sign-in-able owner + workspace + project with the project PINNED active —
// then seeds sprints + backlog issues entirely through the SHIPPED services
// (the one sanctioned cross-layer reach for E2E setup, exactly as
// `work-item-setup.ts` creates projects via `projectsService` and the board
// at-scale spec seeds via `seedLargeBoard`). No raw inserts: every issue rides
// `backlogService.createBacklogIssue`, so it gets a real `backlog_rank` (append
// order = rank order = display order) and a 1.4.6 revision, the same path the
// product uses.
//
// Two fixtures:
//   • seedGroomingBacklog — a SMALL controlled fixture (one planned sprint with
//     one issue + five ranked backlog issues) for the functional grooming
//     session (render, rank-drag, assign-drag, bulk move, inline create).
//   • seedScaleBacklog    — a LARGE backlog (default 120 issues) for the
//     finding-#57 at-scale checks (bounded count header, virtualized DOM,
//     lazy-load on scroll, drag still works out of the windowed list). The
//     in-process analogue of the `db:seed:large` board fixture the board
//     at-scale spec uses.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Satisfies the credential-strength rule (same shape as seedLargeBoard's).
export const BACKLOG_SEED_PASSWORD = 'backlog-e2e-pass-9';

export interface SeededIssue {
  id: string;
  identifier: string;
  title: string;
}

export interface BacklogSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  /** The one planned sprint (grooming fixture); '' for the scale fixture. */
  sprintId: string;
  sprintName: string;
  /** Issues born inside the sprint (grooming fixture seeds one). */
  sprintIssues: SeededIssue[];
  /** Ranked backlog issues, in display (rank) order. */
  backlogIssues: SeededIssue[];
}

async function makeTenant(
  email: string,
  workspaceName: string,
  projectName: string,
  identifier: string,
): Promise<{ ctx: ServiceContext; projectId: string; projectIdentifier: string }> {
  const owner = await usersService.createUser({
    email,
    password: BACKLOG_SEED_PASSWORD,
    name: 'Backlog Owner',
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
  // Pin the project active for the owner so the active-project-scoped /backlog
  // route resolves it on sign-in (the same pin seed-large.ts does for /boards).
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectIdentifier: project.identifier,
  };
}

async function createBacklogIssue(
  ctx: ServiceContext,
  projectId: string,
  title: string,
  sprintId?: string,
): Promise<SeededIssue> {
  const dto = await backlogService.createBacklogIssue(
    projectId,
    { kind: 'story', title, sprintId: sprintId ?? null },
    ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title };
}

/** The small grooming fixture: one planned sprint (1 work item) + 5 backlog issues. */
export async function seedGroomingBacklog(email: string): Promise<BacklogSeed> {
  const { ctx, projectId, projectIdentifier } = await makeTenant(
    email,
    'Backlog E2E — grooming',
    'Groom',
    'GRM',
  );
  const sprintName = 'Sprint Alpha';
  const sprint = await sprintsService.createSprint(projectId, { name: sprintName }, ctx);
  // One issue born inside the sprint — a stable drop target + a non-zero start
  // count so the assign-drag count assertion (1 → 2) is unambiguous.
  const sprintIssues = [await createBacklogIssue(ctx, projectId, 'Sprint seed issue', sprint.id)];
  const backlogIssues: SeededIssue[] = [];
  for (const title of [
    'Backlog one',
    'Backlog two',
    'Backlog three',
    'Backlog four',
    'Backlog five',
  ]) {
    backlogIssues.push(await createBacklogIssue(ctx, projectId, title));
  }
  return {
    email,
    password: BACKLOG_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    projectIdentifier,
    sprintId: sprint.id,
    sprintName,
    sprintIssues,
    backlogIssues,
  };
}

/** The large fixture: `count` ranked backlog issues (finding #57 at-scale). */
export async function seedScaleBacklog(email: string, count = 120): Promise<BacklogSeed> {
  const { ctx, projectId, projectIdentifier } = await makeTenant(
    email,
    'Backlog E2E — at scale',
    'Scale',
    'SCL',
  );
  const backlogIssues: SeededIssue[] = [];
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(3, '0');
    backlogIssues.push(await createBacklogIssue(ctx, projectId, `Scale issue ${n}`));
  }
  return {
    email,
    password: BACKLOG_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    projectIdentifier,
    sprintId: '',
    sprintName: '',
    sprintIssues: [],
    backlogIssues,
  };
}
