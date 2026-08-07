// Child-panel GRAPH seed (Story MOTIR-2284 · MOTIR-2290).
//
// The panel's whole claim is that it draws the ORDER a parent's children build
// in, so the fixture has to carry that order: the children are wired with real
// `is_blocked_by` edges (design → code → test), which is what puts arrows on the
// canvas. A fixture without them would satisfy every node assertion while
// proving nothing.
//
// It also mints the two things the spec's negative assertions need:
//   · a SECOND root epic that is NOT under the parent — visible only on the
//     project's root level, so "the panel stayed fenced to the item" is
//     observable as its absence;
//   · a LEAF work item — the case where the Children section must not render.
//
// Seeded through the SHIPPED services (the one sanctioned cross-layer reach for
// E2E setup, as `planning-anchor-seed.ts` / `roadmap-seed.ts` already do), so
// the tree, the links and the per-level read the canvas hits are all real.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

export const CHILD_PANEL_GRAPH_PASSWORD = 'child-panel-graph-e2e-pass-7';

export interface ChildPanelGraphSeed {
  email: string;
  password: string;
  projectKey: string;
  /** The parent the Children panel is read on. */
  storyKey: string;
  storyTitle: string;
  /** Its three children, in dependency order — design blocks code blocks test. */
  designKey: string;
  designTitle: string;
  codeKey: string;
  codeTitle: string;
  testKey: string;
  testTitle: string;
  /** The code child's own child — what a drill from the panel descends into. */
  grandchildKey: string;
  grandchildTitle: string;
  /** A root epic OUTSIDE the story's subtree: only ever drawn on the project
   *  root level, so its absence proves the panel never walked out of the item. */
  otherEpicTitle: string;
  /** A childless item — the Children section must not render at all on it. */
  leafKey: string;
}

export async function seedChildPanelGraph(email: string): Promise<ChildPanelGraphSeed> {
  const owner = await usersService.createUser({
    email,
    password: CHILD_PANEL_GRAPH_PASSWORD,
    name: 'Child Panel Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Child Panel E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Child Panel',
    identifier: 'CPG',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'Work-item surfaces' },
    ctx,
  );

  const storyTitle = 'Child panel — List and Graph';
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: storyTitle, parentId: epic.id },
    ctx,
  );

  const designTitle = 'Design the switcher';
  const design = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: designTitle, parentId: story.id },
    ctx,
  );
  const codeTitle = 'Build the graph mode';
  const code = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: codeTitle, parentId: story.id },
    ctx,
  );
  const testTitle = 'Cover the panel';
  const test = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: testTitle, parentId: story.id },
    ctx,
  );

  // The ORDER — the reason the graph exists. `is_blocked_by` runs FROM the
  // blocked item TO its blocker, so this reads "code is blocked by design".
  await workItemsService.linkWorkItems(
    { fromId: code.id, toId: design.id, kind: 'is_blocked_by' },
    ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: test.id, toId: code.id, kind: 'is_blocked_by' },
    ctx,
  );

  // A level BELOW the panel's first one, so the drill has somewhere to go — and
  // so the code child is drillable (`hasChildren`).
  const grandchildTitle = 'Thread the URL state';
  const grandchild = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: grandchildTitle, parentId: code.id },
    ctx,
  );

  const otherEpicTitle = 'Billing and plans';
  await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: otherEpicTitle },
    ctx,
  );

  const leaf = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A task with no children', parentId: epic.id },
    ctx,
  );

  return {
    email,
    password: CHILD_PANEL_GRAPH_PASSWORD,
    projectKey: project.identifier,
    storyKey: story.identifier,
    storyTitle,
    designKey: design.identifier,
    designTitle,
    codeKey: code.identifier,
    codeTitle,
    testKey: test.identifier,
    testTitle,
    grandchildKey: grandchild.identifier,
    grandchildTitle,
    otherEpicTitle,
    leafKey: leaf.identifier,
  };
}
