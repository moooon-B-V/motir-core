// Planning-workspace ANCHOR seed (MOTIR-2070).
//
// The bug is only visible on a tree DEEP enough that the anchor's level is not
// the root: opening `/planning?item=<a subtask>` used to land on the epics, three
// manual drills away from the item the workspace was summoned about. So this seed
// mints a tenant with a real `epic → story → subtask` chain — the same shape the
// MOTIR project itself has — plus a SIBLING subtask, which is what proves the
// canvas opened on the level CONTAINING the anchor rather than on the anchor's own
// children (an anchor's children level would show neither the anchor nor its
// sibling).
//
// Seeded entirely through the SHIPPED services (the one sanctioned cross-layer
// reach for E2E setup, exactly as `roadmap-seed.ts` / `plans-review-seed.ts` do) —
// no raw work-item inserts, so the ancestor chain the page reads is a real one.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// Satisfies the credential-strength rule (same shape as the other seeds').
export const PLANNING_ANCHOR_PASSWORD = 'planning-anchor-e2e-pass-7';

export interface PlanningAnchorSeed {
  email: string;
  password: string;
  projectKey: string;
  /** The root-level epic — the anchor's grandparent, and a root-anchor case of its own. */
  epicTitle: string;
  epicKey: string;
  /** The story between them — the level the deep anchor sits ON. */
  storyTitle: string;
  storyKey: string;
  /** The DEEP anchor: a subtask two levels below the root. */
  subtaskTitle: string;
  subtaskKey: string;
  /** Its sibling on the same level — visible iff the canvas opened on that level. */
  siblingTitle: string;
}

export async function seedPlanningAnchorTree(email: string): Promise<PlanningAnchorSeed> {
  const owner = await usersService.createUser({
    email,
    password: PLANNING_ANCHOR_PASSWORD,
    name: 'Planning Anchor Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Planning Anchor E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Anchor',
    identifier: 'ANCH',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active — `/planning` is active-project scoped.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  const epicTitle = 'Platform foundation';
  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: epicTitle },
    ctx,
  );
  const storyTitle = 'Contextual planning';
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: storyTitle, parentId: epic.id },
    ctx,
  );
  const subtaskTitle = 'Seed the canvas at the anchor';
  const subtask = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: subtaskTitle, parentId: story.id },
    ctx,
  );
  const siblingTitle = 'Thread the trail through the host';
  await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: siblingTitle, parentId: story.id },
    ctx,
  );

  // A second root epic, so "the canvas is NOT on the root level" is observable as
  // an absence of something that is only ever drawn there.
  await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'Growth experiments' },
    ctx,
  );

  // The immutable onboarding-ran marker — without it `/planning` forwards to
  // `/onboarding`, which still owns a never-onboarded project.
  await db.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });

  return {
    email,
    password: PLANNING_ANCHOR_PASSWORD,
    projectKey: project.identifier,
    epicTitle,
    epicKey: epic.identifier,
    storyTitle,
    storyKey: story.identifier,
    subtaskTitle,
    subtaskKey: subtask.identifier,
    siblingTitle,
  };
}
