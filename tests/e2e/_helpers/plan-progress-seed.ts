// Plan-progress E2E seed (Story MOTIR-7820 · Subtask MOTIR-7835).
//
// One tenant the whole plan-progress walk runs in:
//   · a READER — the person who asks for plans and follows them from the
//     Workbench › Planning tab;
//   · a TEAMMATE in the same workspace and project, whose own `generating` plan
//     must stay off the reader's tab (case 13);
//   · a project whose story holds ONE committed, still-open TASK — the card one
//     level down that an `add` lands under (case 5's off-level drafting cue) and
//     the card a `lay` step names on the viewed level (case 6);
//   · a project-scoped API token carrying `work_item:edit` + `ai:view_plan`, so an
//     MCP client can create, append, deepen, withdraw and `report_plan_step`
//     through the real `/api/mcp` transport (`agentSession`).
//
// ⚠️ THE STORY'S ONLY CHILD IS OPEN, on purpose. A container's status is DERIVED
// from its children, and a finished story offers no *Plan with AI* at all
// (`planEntranceFace` rule 1) — the receipt opens its hosted plan from this card.
//
// Everything rides the SHIPPED services — the one sanctioned cross-layer reach
// for E2E setup — exactly as `live-drawing-seed.ts`. Every direct row write is on
// `adminDb`: a seed through `@/lib/db` is refused under `motir_app` without
// raising (`tests/rls/test-singleton-statement-guard.test.ts`).

import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestPerson } from './testPerson';

export const PLAN_PROGRESS_PASSWORD = 'plan-progress-e2e-pass-7';

export interface PlanProgressPerson {
  email: string;
  userId: string;
  ctx: ServiceContext;
}

export interface PlanProgressSeed {
  reader: PlanProgressPerson;
  teammate: PlanProgressPerson;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  /** The story every hosted plan in the walk is anchored on. */
  storyId: string;
  storyKey: string;
  storyTitle: string;
  /** The story's committed, still-open task — one level down from the story's
   *  level, and a card ON that level. */
  taskId: string;
  taskKey: string;
  taskTitle: string;
  /** The READER's bearer: `work_item:edit` + `ai:view_plan`, bound to the project. */
  token: string;
}

export async function seedPlanProgress(slug: string): Promise<PlanProgressSeed> {
  const readerPerson = await createTestPerson({
    email: `plan-progress-reader-${slug}@example.com`,
    password: PLAN_PROGRESS_PASSWORD,
    name: 'Noor Reader',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Plan Progress E2E',
    ownerUserId: readerPerson.id,
  });
  const projectName = 'Planner progress';
  const project = await projectsService.createProject({
    name: projectName,
    identifier: 'PROG',
    workspaceId: workspace.id,
    actorUserId: readerPerson.id,
  });

  // The teammate — a plain workspace member. `addMember` enrols them in the
  // workspace's projects, so they can see (and plan in) this one.
  const teammatePerson = await createTestPerson({
    email: `plan-progress-teammate-${slug}@example.com`,
    password: PLAN_PROGRESS_PASSWORD,
    name: 'Ola Teammate',
  });
  await workspacesService.addMember({ userId: teammatePerson.id, workspaceId: workspace.id });

  // The Workbench, `/plans` and the planning surface are ACTIVE-PROJECT scoped.
  for (const userId of [readerPerson.id, teammatePerson.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  const ctx: ServiceContext = { userId: readerPerson.id, workspaceId: workspace.id };
  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'AI planning' },
    ctx,
  );
  const storyTitle = 'Follow a plan while it is written';
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: storyTitle, parentId: epic.id },
    ctx,
  );
  const taskTitle = 'Record the progress receipt';
  const task = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: taskTitle, parentId: story.id },
    ctx,
  );

  const minted = await apiTokensService.create(readerPerson.id, workspace.id, {
    label: 'plan-progress-e2e',
    projectId: project.id,
    permissions: ['work_item:edit', 'ai:view_plan'],
  });

  // Past onboarding, so *Plan with AI* opens the planning surface itself.
  await adminDb.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });

  return {
    reader: { email: readerPerson.email, userId: readerPerson.id, ctx },
    teammate: {
      email: teammatePerson.email,
      userId: teammatePerson.id,
      ctx: { userId: teammatePerson.id, workspaceId: workspace.id },
    },
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    projectName,
    storyId: story.id,
    storyKey: story.identifier,
    storyTitle,
    taskId: task.id,
    taskKey: task.identifier,
    taskTitle,
    token: minted.token,
  };
}

/**
 * Backdate a plan past the stalled threshold, as the server's own clock would
 * see it after `byMs` of silence: its `last_activity_at` and every one of its
 * step rows' `started_at`. Both, because the derivation reads both — the plan's
 * activity for STALLED, each step's start for the QUIET drop.
 */
export async function backdatePlanActivity(planId: string, byMs: number): Promise<Date> {
  const at = new Date(Date.now() - byMs);
  await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: at } });
  await adminDb.planStep.updateMany({ where: { planId }, data: { startedAt: at } });
  return at;
}
