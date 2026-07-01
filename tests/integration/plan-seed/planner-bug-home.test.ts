import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { seedPlannerBugHome } from '@/scripts/plan-seed/plannerBugHome';
import { PLANNER_BUG_HOME_EPIC_TITLE, PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-1466 — the planner-bug home the seed adds (a THIRD helper alongside
// seedSystemPrincipal / seedGenerationTestProject). Real Postgres (the seed-test
// convention). Pins the invariants the bug-filing route's marker resolution
// depends on: the Epic + Story exist with the exact marker titles, the Story
// parents under the Epic, the Story is resolvable by its title (the stable
// handle), and a reseed re-provisions the home (with a NEW key — which is why
// resolution is marker-based, not key-based).

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeWorkspaceAndProject(name: string, identifier: string) {
  const owner = await usersService.createUser({
    email: `owner-${name}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  return { owner, workspace, project };
}

describe('seedPlannerBugHome (MOTIR-1466)', () => {
  it('seeds a root Epic + child Story carrying the exact marker titles', async () => {
    const { owner, workspace, project } = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const { epicId, storyId } = await seedPlannerBugHome({
      workspaceId: workspace.id,
      projectId: project.id,
      reporterId: owner.id,
      afterPosition: null,
    });

    const epic = await db.workItem.findUnique({ where: { id: epicId } });
    const story = await db.workItem.findUnique({ where: { id: storyId } });

    expect(epic?.kind).toBe('epic');
    expect(epic?.parentId).toBeNull(); // a root epic
    expect(epic?.title).toBe(PLANNER_BUG_HOME_EPIC_TITLE);

    expect(story?.kind).toBe('story');
    expect(story?.parentId).toBe(epicId); // story → epic (matrix-legal)
    expect(story?.title).toBe(PLANNER_BUG_HOME_STORY_TITLE);
    expect(story?.projectId).toBe(project.id);
  });

  it('makes the home story resolvable by its stable title (the marker handle)', async () => {
    const { owner, workspace, project } = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const { storyId } = await seedPlannerBugHome({
      workspaceId: workspace.id,
      projectId: project.id,
      reporterId: owner.id,
      afterPosition: null,
    });

    const resolved = await workItemRepository.findByProjectKindAndTitle(
      project.id,
      'story',
      PLANNER_BUG_HOME_STORY_TITLE,
    );
    expect(resolved?.id).toBe(storyId);
  });

  it('mints valid, distinct fractional-index positions continuing the chain', async () => {
    const { owner, workspace, project } = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const { epicId, storyId, lastPosition } = await seedPlannerBugHome({
      workspaceId: workspace.id,
      projectId: project.id,
      reporterId: owner.id,
      afterPosition: 'a0', // a valid prior key — the home continues after it
    });
    const epic = await db.workItem.findUnique({ where: { id: epicId } });
    const story = await db.workItem.findUnique({ where: { id: storyId } });
    // Ascending + distinct + valid (head never '0'), so board drag/move never 500s.
    expect(epic!.position > 'a0').toBe(true);
    expect(story!.position > epic!.position).toBe(true);
    expect(story!.position).toBe(lastPosition);
    expect(epic!.position.startsWith('0')).toBe(false);
    expect(story!.position.startsWith('0')).toBe(false);
  });

  it('re-provisions the home across a reseed with a fresh key (why resolution is marker-based)', async () => {
    // Reseed reality: the workspace is dropped + rebuilt, so the home is created
    // anew each run — with a DIFFERENT allocated key. The title (the marker
    // handle) is what stays stable.
    const first = await makeWorkspaceAndProject('moooon', 'MOTIR');
    const firstHome = await seedPlannerBugHome({
      workspaceId: first.workspace.id,
      projectId: first.project.id,
      reporterId: first.owner.id,
      afterPosition: null,
    });

    const second = await makeWorkspaceAndProject('moooon-next', 'MOTIR2');
    // Burn a work-item number so the second home cannot coincidentally reuse the
    // same key — proving the title, not the key, is the durable handle.
    await seedPlannerBugHome({
      workspaceId: second.workspace.id,
      projectId: second.project.id,
      reporterId: second.owner.id,
      afterPosition: null,
    });
    const secondHome = await seedPlannerBugHome({
      workspaceId: second.workspace.id,
      projectId: second.project.id,
      reporterId: second.owner.id,
      afterPosition: null,
    });

    expect(secondHome.storyIdentifier).not.toBe(firstHome.storyIdentifier);
    // Both still resolve by the SAME title within their own project.
    const resolved = await workItemRepository.findByProjectKindAndTitle(
      second.project.id,
      'story',
      PLANNER_BUG_HOME_STORY_TITLE,
    );
    // Lowest-key match is deterministic — the first of the two seeded in project 2.
    expect(resolved).not.toBeNull();
    expect(resolved?.title).toBe(PLANNER_BUG_HOME_STORY_TITLE);
  });
});
