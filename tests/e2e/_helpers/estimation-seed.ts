// Estimation E2E seed helpers (Story 4.3 · the closing test Subtask 4.3.7).
//
// The per-subtask service + component tests already prove the estimate write,
// the project config CRUD, the bounded sprint/epic roll-ups (incl. the
// statistic switch), and the badge / settings UI in isolation
// (tests/integration/estimation/service.test.ts + tests/components/estimate-
// badge|rollup-displays|estimation-settings-editor). THIS spec proves the same
// estimation journey works for real — a signed-in user estimating issues on
// `/backlog`, watching the committed-points + epic roll-ups react, editing the
// project Estimation settings — through the actual HTTP + DB round-trip, and
// that the roll-ups stay BOUNDED aggregates (never a client load-all + sum) and
// the surface stays virtualized at scale (finding #57).
//
// Like backlog-seed.ts, every fixture mints its OWN tenant (a sign-in-able owner
// + workspace + project PINNED active — the `/backlog` + `/settings/project/*`
// routes are active-project scoped) and seeds entirely through the SHIPPED
// services (the one sanctioned cross-layer reach for E2E setup): issues ride
// `backlogService.createBacklogIssue` (real `backlog_rank` + a 1.4.6 revision)
// or `workItemsService.createWorkItem` (for the parented epic→child tree the
// rollup needs), sprints ride `sprintsService.createSprint`, and estimates ride
// `estimationService.setEstimate` — the same paths the product uses. No raw
// inserts.
//
// Two fixtures:
//   • seedEstimationFixture — a SMALL controlled tenant (a planned sprint with
//     one issue, a plain backlog story, an epic with one estimable child) for
//     the functional estimate / roll-up / settings session.
//   • seedScaleEstimation   — a LARGE tenant (many backlog issues + a sprint of
//     estimated issues + an epic with an estimated subtree) for the finding-#57
//     at-scale checks (bounded aggregates, virtualized DOM). The in-process
//     analogue of the `db:seed:large` fixture the story's verification recipe
//     names — same convention as backlog-seed.ts's seedScaleBacklog.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { workItemsService } from '@/lib/services/workItemsService';
import { estimationService } from '@/lib/services/estimationService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Satisfies the credential-strength rule (same shape as backlog-seed's).
export const ESTIMATION_SEED_PASSWORD = 'estimation-e2e-pass-9';

export interface SeededIssue {
  id: string;
  identifier: string;
  title: string;
}

export interface EstimationSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  sprintId: string;
  sprintName: string;
  /** The one issue born inside the sprint (estimable for the committed roll-up). */
  sprintIssue: SeededIssue;
  /** A plain ranked backlog story — the headline "estimate a backlog story". */
  backlogStory: SeededIssue;
  /** An epic with one estimable child — the parent subtree roll-up. */
  epic: SeededIssue;
  childStory: SeededIssue;
}

async function makeTenant(
  email: string,
  workspaceName: string,
  projectName: string,
  identifier: string,
): Promise<{ ctx: ServiceContext; projectId: string; projectIdentifier: string }> {
  const owner = await usersService.createUser({
    email,
    password: ESTIMATION_SEED_PASSWORD,
    name: 'Estimation Owner',
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
  // Pin the project active for the owner so the active-project-scoped routes
  // resolve it on sign-in (the same pin seed-large.ts / backlog-seed.ts use).
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

async function createChild(
  ctx: ServiceContext,
  projectId: string,
  parentId: string,
  kind: 'story' | 'task' | 'subtask',
  title: string,
): Promise<SeededIssue> {
  const dto = await workItemsService.createWorkItem({ projectId, parentId, kind, title }, ctx);
  return { id: dto.id, identifier: dto.identifier, title };
}

/** The small functional fixture: a planned sprint (1 issue) + a backlog story +
 *  an epic with one estimable child. Nothing is estimated up front — the spec
 *  estimates through the UI and watches the roll-ups react. */
export async function seedEstimationFixture(email: string): Promise<EstimationSeed> {
  const { ctx, projectId, projectIdentifier } = await makeTenant(
    email,
    'Estimation E2E — functional',
    'Estimate',
    'EST',
  );

  const sprintName = 'Sprint Alpha';
  const sprint = await sprintsService.createSprint(projectId, { name: sprintName }, ctx);
  const sprintIssue = await createBacklogIssue(ctx, projectId, 'Sprint seed issue', sprint.id);
  const backlogStory = await createBacklogIssue(ctx, projectId, 'Backlog story to estimate');

  // An epic with one child — the child estimate rolls up into the epic header
  // badge (which renders only when the parent has descendants).
  const epicDto = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: 'Epic Atlas' },
    ctx,
  );
  const epic: SeededIssue = { id: epicDto.id, identifier: epicDto.identifier, title: 'Epic Atlas' };
  const childStory = await createChild(ctx, projectId, epic.id, 'story', 'Atlas child story');

  return {
    email,
    password: ESTIMATION_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    projectIdentifier,
    sprintId: sprint.id,
    sprintName,
    sprintIssue,
    backlogStory,
    epic,
    childStory,
  };
}

export interface ScaleEstimationSeed {
  email: string;
  password: string;
  projectId: string;
  sprintId: string;
  sprintName: string;
  epic: SeededIssue;
  /** Count of ranked backlog issues (virtualized-DOM check). */
  backlogCount: number;
  /** The deterministic committed-point total of the sprint's estimated issues. */
  sprintCommitted: number;
  /** The deterministic rolled-up point total of the epic's estimated subtree. */
  epicTotal: number;
}

/**
 * The large fixture (finding #57 at-scale). Seeds, deterministically:
 *   • `backlogCount` ranked, UNestimated backlog issues — so the virtualized
 *     `/backlog` list proves the DOM stays bounded (only the window mounts);
 *   • a planned sprint of `sprintSize` estimated issues — so `rollupForSprint`
 *     is exercised as ONE bounded grouped aggregate over many rows, never a
 *     client sum of the loaded page;
 *   • an epic with a `subtreeSize`-deep estimated subtree — so `rollupForParent`
 *     is ONE bounded recursive-CTE aggregate over the descendants.
 * Counts are kept modest (the in-process per-issue create transactions add up),
 * but large enough that the list virtualizes and the aggregates clearly are not
 * the loaded-row count.
 */
export async function seedScaleEstimation(
  email: string,
  { backlogCount = 60, sprintSize = 12, subtreeSize = 6 } = {},
): Promise<ScaleEstimationSeed> {
  const { ctx, projectId } = await makeTenant(
    email,
    'Estimation E2E — at scale',
    'EstScale',
    'ESS',
  );

  for (let i = 1; i <= backlogCount; i++) {
    await createBacklogIssue(ctx, projectId, `Scale backlog ${String(i).padStart(3, '0')}`);
  }

  const sprintName = 'Sprint Scale';
  const sprint = await sprintsService.createSprint(projectId, { name: sprintName }, ctx);
  let sprintCommitted = 0;
  for (let i = 1; i <= sprintSize; i++) {
    const issue = await createBacklogIssue(ctx, projectId, `Scale sprint ${i}`, sprint.id);
    const points = (i % 5) + 1; // 1..5, deterministic
    await estimationService.setEstimate(issue.id, points, ctx);
    sprintCommitted += points;
  }

  // A linear epic→child chain, each level estimated, so the recursive subtree
  // aggregate has to walk depth (not just direct children).
  const epicDto = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: 'Scale Epic' },
    ctx,
  );
  const epic: SeededIssue = { id: epicDto.id, identifier: epicDto.identifier, title: 'Scale Epic' };
  let epicTotal = 0;
  let parentId = epic.id;
  for (let i = 1; i <= subtreeSize; i++) {
    const kind = i === 1 ? 'story' : i === 2 ? 'task' : 'subtask';
    const child = await createChild(ctx, projectId, parentId, kind, `Scale descendant ${i}`);
    const points = (i % 3) + 1; // 1..3
    await estimationService.setEstimate(child.id, points, ctx);
    epicTotal += points;
    // Nest the next level under this one only while the kind hierarchy allows
    // it (epic→story→task→subtask); deeper levels stay siblings under the task.
    if (i <= 2) parentId = child.id;
  }

  return {
    email,
    password: ESTIMATION_SEED_PASSWORD,
    projectId,
    sprintId: sprint.id,
    sprintName,
    epic,
    backlogCount,
    sprintCommitted,
    epicTotal,
  };
}
