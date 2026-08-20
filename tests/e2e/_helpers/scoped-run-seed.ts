import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { apiTokensService } from '@/lib/services/apiTokensService';

// The fixture for the SCOPED-RUN acceptance walk (Story MOTIR-3001 ·
// MOTIR-3201): a story whose children a run can claim as one set, plus the
// bearer a terminal-side flow presents.
//
// ⚠️ SEEDED THROUGH THE SERVICES, not through `/api/_test/work-items`, and the
// reason is the SHAPE. The test route creates a `task` with a title; this story
// needs a container with children at two depths, a dependency edge between two
// of them, a `manual` member, and a second story to prove the claim does not
// reach past its own scope. Every one of those is a create-time argument the
// services take and that route does not.
//
// ⚠️ NO `@/lib/db` SINGLETON WRITES. `tests/rls/test-singleton-statement-guard`
// ratchets that population down over `tests/e2e/**`, and a direct singleton
// write is REFUSED under `motir_app` while a direct read returns `[]` — neither
// of which raises, so the failure would arrive as an empty fixture rather than
// as an error. `db-reset`'s client is the admin one, and it is used here only
// for the active-project pin the services do not expose.

export const SCOPED_RUN_PASSWORD = 'hunter2hunter2';

export interface SeededCard {
  id: string;
  identifier: string;
}

export interface ScopedRunSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** The story a scoped run claims. */
  story: SeededCard;
  /** Its first child — nothing blocks it. */
  first: SeededCard;
  /** Blocked by {@link ScopedRunSeed.first}: the run must work it second. */
  second: SeededCard;
  /** A `manual` / `executor: human` member — claimed, never agent-workable. */
  manual: SeededCard;
  /** A card OUTSIDE the story, to prove the claim does not reach past its scope. */
  outsider: SeededCard;
  /** A bearer with exactly the two permissions the two doors assert. */
  token: string;
}

/**
 * One workspace, one project, one story with three children and one outsider.
 *
 * The token carries EXACTLY `project:browse` (the ready read) and
 * `work_item:edit` (the scope claim) — so a green run is evidence about those
 * two permissions rather than about a broadly-granted token.
 */
export async function seedScopedRun(email: string, identifier: string): Promise<ScopedRunSeed> {
  const owner = await usersService.createUser({
    email,
    password: SCOPED_RUN_PASSWORD,
    name: 'Scoped Runner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Scoped run',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Scoped run',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const make = async (
    title: string,
    over: {
      kind?: 'story' | 'task' | 'subtask';
      parentId?: string;
      type?: 'code' | 'manual';
      executor?: 'coding_agent' | 'human';
    } = {},
  ): Promise<SeededCard> => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: over.kind ?? 'subtask',
        title,
        ...(over.parentId ? { parentId: over.parentId } : {}),
        ...(over.type ? { type: over.type } : {}),
        ...(over.executor ? { executor: over.executor } : {}),
      },
      ctx,
    );
    return { id: item.id, identifier: item.identifier };
  };

  const story = await make('Run a whole story in one go', { kind: 'story' });
  const first = await make('Publish the scoped ready set', { parentId: story.id });
  const second = await make('Drain the claimed scope', { parentId: story.id });
  const manual = await make('Turn the feature flag on', {
    parentId: story.id,
    type: 'manual',
    executor: 'human',
  });
  const outsider = await make('Something else entirely', { kind: 'task' });

  // The edge that makes the run's ORDER observable rather than incidental.
  await workItemsService.linkWorkItems(
    { fromId: second.id, toId: first.id, kind: 'is_blocked_by' },
    ctx,
  );

  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'scoped-run-e2e',
    projectId: project.id,
    permissions: ['project:browse', 'work_item:edit'],
  });

  return {
    email,
    password: SCOPED_RUN_PASSWORD,
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    story,
    first,
    second,
    manual,
    outsider,
    token: minted.token,
  };
}

/** A story whose child is itself a CONTAINER — the shape a scoped run refuses. */
export async function seedTwoLayerStory(
  seed: ScopedRunSeed,
): Promise<{ story: SeededCard; container: SeededCard; buried: SeededCard }> {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const story = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: 'A story with a layer too many' },
    ctx,
  );
  const container = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title: 'A task of its own', parentId: story.id },
    ctx,
  );
  const buried = await workItemsService.createWorkItem(
    {
      projectId: seed.projectId,
      kind: 'subtask',
      title: 'Two levels down',
      parentId: container.id,
    },
    ctx,
  );
  return {
    story: { id: story.id, identifier: story.identifier },
    container: { id: container.id, identifier: container.identifier },
    buried: { id: buried.id, identifier: buried.identifier },
  };
}

/** A story nobody has decomposed — a planning item, with nothing to run. */
export async function seedChildlessStory(seed: ScopedRunSeed): Promise<SeededCard> {
  const item = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: 'Never expanded' },
    { userId: seed.userId, workspaceId: seed.workspaceId },
  );
  return { id: item.id, identifier: item.identifier };
}

/**
 * An ACTIVE sprint holding items at MIXED kinds and depths — a story, one of its
 * children, and a loose task. Legitimate, and the reason a sprint scope has no
 * shape rule.
 */
export async function seedMixedSprint(
  seed: ScopedRunSeed,
  itemIds: string[],
): Promise<{ id: string }> {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const sprint = await sprintsService.createSprint(seed.projectId, { name: 'Mixed sprint' }, ctx);
  await backlogService.bulkAssignToSprint(itemIds, sprint.id, ctx);
  await sprintsService.startSprint(sprint.id, {}, ctx);
  return { id: sprint.id };
}
