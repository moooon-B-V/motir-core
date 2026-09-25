// Live-drawing E2E seed (Story MOTIR-6158 · Subtask MOTIR-6302).
//
// One tenant the whole acceptance walk runs in: a person who plans, a story the
// plan is written under, a SECOND story for the arrival that lands elsewhere, and
// a project-scoped API token so an agent can write a plan over the real MCP
// transport (`agent-authored-plan-seed.ts`'s `agentSession`).
//
// ⚠️ THE STORY HOLDS A `done` CHILD, and that is load-bearing (case 6): a finished
// card the plan does not touch must look on the live canvas exactly as it does on
// `/roadmap` — no lock hatch. A plan only LOCKS a terminal card it modifies or
// removes (MOTIR-6296), so the card has to be on the level without being touched.
// It reaches `done` along the legal workflow path, as `roadmap-seed.ts` does it.
//
// Everything rides the SHIPPED services — the one sanctioned cross-layer reach for
// E2E setup — exactly as `plans-review-seed.ts` and `agent-authored-plan-seed.ts`.

import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestPerson } from './testPerson';

export const LIVE_DRAWING_PASSWORD = 'live-drawing-e2e-pass-7';

export interface LiveDrawingSeed {
  email: string;
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  /** The story every plan in the walk is written under. */
  storyId: string;
  storyKey: string;
  /** Its `done` child — on the level, untouched by any plan. */
  doneTitle: string;
  /** Its still-open child — what keeps the story itself open. */
  openTitle: string;
  /** The OTHER story — the parent of the arrival that lands elsewhere (case 7). */
  elsewhereId: string;
  elsewhereKey: string;
  /** A bearer carrying `work_item:edit` + `ai:view_plan`, bound to the project. */
  token: string;
}

export async function seedLiveDrawing(email: string): Promise<LiveDrawingSeed> {
  const owner = await createTestPerson({
    email,
    password: LIVE_DRAWING_PASSWORD,
    name: 'Rin Planner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Live Drawing E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Planning surface',
    identifier: 'LIVE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // `/plans` and the planning surface are ACTIVE-PROJECT scoped.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'AI planning' },
    ctx,
  );
  const story = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'story',
      title: 'Draw the plan as it is written',
      parentId: epic.id,
    },
    ctx,
  );
  // ⚠️ AN OPEN CHILD FIRST. A container's status is DERIVED from its
  // children, so a story whose only child is `done` is itself `done` — and a
  // finished item offers no *Plan with AI* at all (`planEntranceFace` rule 1).
  // Created BEFORE the other child is finished, so the story is never `done` —
  // not even for the moment a background status job could act on it.
  const openTitle = 'Record the live-drawing receipt';
  await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: openTitle, parentId: story.id },
    ctx,
  );

  const doneTitle = 'Share one card between plan and roadmap';
  const done = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: doneTitle, parentId: story.id },
    ctx,
  );
  await workItemsService.updateStatus(done.id, 'in_progress', ctx);
  await workItemsService.updateStatus(done.id, 'in_review', ctx);
  await workItemsService.updateStatus(done.id, 'done', ctx);

  const elsewhere = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Plans page polish', parentId: epic.id },
    ctx,
  );

  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'live-drawing-e2e',
    projectId: project.id,
    permissions: ['work_item:edit', 'ai:view_plan'],
  });

  // Past onboarding, so *Plan with AI* opens the planning surface itself.
  await db.project.update({ where: { id: project.id }, data: { onboardingRanAt: new Date() } });

  return {
    email,
    ctx,
    projectId: project.id,
    projectKey: project.identifier,
    storyId: story.id,
    storyKey: story.identifier,
    doneTitle,
    openTitle,
    elsewhereId: elsewhere.id,
    elsewhereKey: elsewhere.identifier,
    token: minted.token,
  };
}
