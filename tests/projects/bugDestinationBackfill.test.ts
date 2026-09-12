import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { DEFAULT_BUG_CONTAINER_KIND } from '@/lib/bugs/defaultBugContainer';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `bugDestinationService.backfillDestination` — Story MOTIR-4927 · Subtask
// MOTIR-4936, driven by `pnpm db:backfill:bug-destinations`.
//
// The other half of MOTIR-4935: that card gives every NEW project a container,
// this one gives every EXISTING project a destination. Together they turn
// `ensure_planner_bug_home`'s one-shot data migration into a standing invariant.
//
// A project that predates the pointer is simulated by clearing it — which is
// exactly the state the backfill is written for, and the only state it acts on.

let seq = 0;

async function makeProject(tag: string) {
  const n = seq++;
  const user = await usersService.createUser({
    email: `bug-bf-${tag}-${n}@example.com`,
    password: 'hunter2hunter2',
    name: `Owner ${tag}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${tag} ${n}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${tag} ${n}`,
  });
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    ctx: { userId: user.id, workspaceId: workspace.id },
    seededContainerId: row.bugDestinationId!,
  };
}

/** A project as it stood BEFORE MOTIR-4934 — no pointer at all. */
async function asPreBackfill(projectId: string): Promise<void> {
  await adminDb.project.update({ where: { id: projectId }, data: { bugDestinationId: null } });
}

async function pointerOf(projectId: string): Promise<string | null> {
  return (await adminDb.project.findUniqueOrThrow({ where: { id: projectId } })).bugDestinationId;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────

describe('a project that already carries a LEGACY home', () => {
  it('is POINTED at that home — no second container is created', async () => {
    // The meta tenant's case. The story is explicit that the existing
    // `story`-kind home stays exactly as it is and is simply what the pointer is
    // backfilled to: the `task` kind is a decision about NEW containers, not a
    // migration of old ones.
    const fx = await makeProject('legacy');
    await asPreBackfill(fx.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );
    const countBefore = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const outcome = await bugDestinationService.backfillDestination(fx.projectId, fx.userId);

    expect(outcome).toBe('pointed_at_legacy_home');
    expect(await pointerOf(fx.projectId)).toBe(home.id);
    // Nothing created — the point of this branch.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(countBefore);
    // And the home is untouched: same kind, same title.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.id } });
    expect(row.kind).toBe('story');
    expect(row.title).toBe(PLANNER_BUG_HOME_STORY_TITLE);
  });

  it('leaves the legacy title resolving for that tenant afterwards', async () => {
    // The story's acceptance criterion: the existing home continues to resolve
    // with `PLANNER_BUG_HOME_STORY_TITLE` unchanged — now THROUGH the pointer
    // rather than through the title lookup.
    const fx = await makeProject('legacy-resolves');
    await asPreBackfill(fx.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );

    await bugDestinationService.backfillDestination(fx.projectId, fx.userId);
    const resolved = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(resolved).toEqual({ parentId: home.id, reason: 'configured' });
  });
});

describe('a project with no home at all', () => {
  it('gets a freshly seeded container and a pointer at it', async () => {
    const fx = await makeProject('fresh');
    await asPreBackfill(fx.projectId);

    const outcome = await bugDestinationService.backfillDestination(fx.projectId, fx.userId);

    expect(outcome).toBe('seeded_container');
    const pointer = await pointerOf(fx.projectId);
    expect(pointer).not.toBeNull();
    const container = await adminDb.workItem.findUniqueOrThrow({ where: { id: pointer! } });
    expect(container.kind).toBe(DEFAULT_BUG_CONTAINER_KIND);
    expect(container.projectId).toBe(fx.projectId);
    expect(container.reporterId).toBe(fx.userId);
  });

  it('leaves NO project without a destination — the invariant the sweep exists for', async () => {
    const a = await makeProject('inv-a');
    const b = await makeProject('inv-b');
    await asPreBackfill(a.projectId);
    await asPreBackfill(b.projectId);

    await bugDestinationService.backfillDestination(a.projectId, a.userId);
    await bugDestinationService.backfillDestination(b.projectId, b.userId);

    const unpointed = await adminDb.project.count({ where: { bugDestinationId: null } });
    expect(unpointed).toBe(0);
  });
});

describe('re-running it', () => {
  it('is a NO-OP for a project that already has a pointer', async () => {
    // What makes the sweep safe to re-run — and the guard that stops it
    // overwriting a destination somebody configured.
    const fx = await makeProject('noop');
    const before = await pointerOf(fx.projectId);

    const outcome = await bugDestinationService.backfillDestination(fx.projectId, fx.userId);

    expect(outcome).toBe('already_pointed');
    expect(await pointerOf(fx.projectId)).toBe(before);
    expect(before).toBe(fx.seededContainerId);
  });

  it('creates nothing on a second pass', async () => {
    const fx = await makeProject('twice');
    await asPreBackfill(fx.projectId);

    await bugDestinationService.backfillDestination(fx.projectId, fx.userId);
    const afterFirst = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const pointerAfterFirst = await pointerOf(fx.projectId);

    const second = await bugDestinationService.backfillDestination(fx.projectId, fx.userId);

    expect(second).toBe('already_pointed');
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(afterFirst);
    expect(await pointerOf(fx.projectId)).toBe(pointerAfterFirst);
  });

  it('does NOT touch a project whose destination is a container the team re-pointed', async () => {
    const fx = await makeProject('repointed');
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Our own triage bucket' },
      fx.ctx,
    );
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { bugDestinationId: elsewhere.id },
    });

    const outcome = await bugDestinationService.backfillDestination(fx.projectId, fx.userId);

    expect(outcome).toBe('already_pointed');
    expect(await pointerOf(fx.projectId)).toBe(elsewhere.id);
  });
});
