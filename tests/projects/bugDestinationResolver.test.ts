import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `bugDestinationService.resolve` — Story MOTIR-4927 · Subtask MOTIR-4937.
//
// The ONE seam that answers *where does a bug go in this project?*. Before it,
// there were two answers — the project's pointer and a project-wide title match
// — and two resolvers with different fallbacks answering one question is what
// this card exists to end.
//
// Every branch is exercised against real Postgres, and the two RECOVERY cases
// are driven by actually archiving and actually deleting a container rather than
// by mocking the read, because the whole value of the branch is that it holds
// when the database state is real.

let seq = 0;

async function makeProject(tag: string) {
  const n = seq++;
  const user = await usersService.createUser({
    email: `bug-res-${tag}-${n}@example.com`,
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
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    ctx,
    /** The container `createProject` seeded — read off the POINTER, never by
     *  title, which is the lookup this story removes. */
    containerId: row.bugDestinationId!,
  };
}

/** Put a project back into the pre-backfill state: no pointer. */
async function clearPointer(projectId: string): Promise<void> {
  await adminDb.project.update({ where: { id: projectId }, data: { bugDestinationId: null } });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────

describe('branch 1 — the pointer is set and healthy', () => {
  it('returns the configured container', async () => {
    const fx = await makeProject('healthy');

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: fx.containerId, reason: 'configured' });
  });

  it('follows a RE-POINTED destination — the point of a pointer over a title', async () => {
    const fx = await makeProject('repoint');
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Triage' },
      fx.ctx,
    );
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { bugDestinationId: elsewhere.id },
    });

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: elsewhere.id, reason: 'configured' });
  });

  it('keeps resolving after the container is RENAMED — the title is not load-bearing', async () => {
    // The defect the pointer exists to remove: under the legacy title lookup a
    // user renaming their container silently broke filing.
    const fx = await makeProject('renamed');
    await adminDb.workItem.update({
      where: { id: fx.containerId },
      data: { title: 'Incoming defects (renamed by the team)' },
    });

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: fx.containerId, reason: 'configured' });
  });
});

describe('branch 2 — the pointer is set but the container is gone', () => {
  it('recovers to the ROOT when the container is ARCHIVED, and says why', async () => {
    // Archiving is a SOFT remove: the row survives, so no foreign-key action can
    // see it. This branch is the only thing that can.
    const fx = await makeProject('archived');
    await adminDb.workItem.update({
      where: { id: fx.containerId },
      data: { archivedAt: new Date() },
    });

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: null, reason: 'container_archived' });
  });

  it('recovers to the ROOT when the container is DELETED — the FK nulls the pointer first', async () => {
    // ⚠️ The card's branch 2 names ARCHIVED *and* DELETED together, and only the
    // archived limb is reachable HERE: MOTIR-4934 gave the foreign key
    // `ON DELETE SET NULL`, so a deleted container has already become a null
    // pointer by the time the resolver runs. The deleted limb is discharged one
    // layer down, by the database. The OUTCOME the story asks for is identical —
    // the root, and never a dangling id — which is what this asserts.
    const fx = await makeProject('deleted');
    await adminDb.workItem.delete({ where: { id: fx.containerId } });

    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.bugDestinationId).toBeNull(); // the FK, not the resolver

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);
    expect(result.parentId).toBeNull();
  });

  it('NEVER returns the id of an archived or deleted work item, under any branch', async () => {
    // The property the whole seam exists for, asserted as a property rather than
    // inferred from the branches above.
    const archived = await makeProject('never-a');
    await adminDb.workItem.update({
      where: { id: archived.containerId },
      data: { archivedAt: new Date() },
    });
    const deleted = await makeProject('never-d');
    await adminDb.workItem.delete({ where: { id: deleted.containerId } });

    for (const fx of [archived, deleted]) {
      const { parentId } = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);
      if (parentId === null) continue;
      const row = await adminDb.workItem.findUnique({ where: { id: parentId } });
      expect(row).not.toBeNull();
      expect(row!.archivedAt).toBeNull();
    }
  });
});

describe('branch 3 — the pointer is null, deliberately', () => {
  it('returns the ROOT, and a caller can tell CHOSEN from RECOVERED', async () => {
    // The card's own criterion: branch 3 must be distinguishable in the RESULT
    // from branch 2's fallback. Both return a null parent; only the `reason`
    // separates "the team wanted this" from "something they pointed at vanished".
    const chosen = await makeProject('chosen');
    await clearPointer(chosen.projectId);

    const recovered = await makeProject('recovered');
    await adminDb.workItem.update({
      where: { id: recovered.containerId },
      data: { archivedAt: new Date() },
    });

    const a = await bugDestinationService.resolve(chosen.projectId, chosen.workspaceId);
    const b = await bugDestinationService.resolve(recovered.projectId, recovered.workspaceId);

    expect(a).toEqual({ parentId: null, reason: 'root_selected' });
    expect(b).toEqual({ parentId: null, reason: 'container_archived' });
    expect(a.parentId).toBe(b.parentId); // same destination…
    expect(a.reason).not.toBe(b.reason); // …different story
  });
});

describe('branch 4 — the TRANSITIONAL legacy fallback', () => {
  it('falls through to a legacy title-matched home when the project has no pointer', async () => {
    // What makes this seam safe to ship BEFORE MOTIR-4936's backfill has run
    // everywhere: a project the backfill has not reached still files where it
    // always did.
    const fx = await makeProject('legacy');
    await clearPointer(fx.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: home.id, reason: 'legacy_title_home' });
  });

  it('does NOT resurrect an ARCHIVED legacy home — it falls to the root', async () => {
    const fx = await makeProject('legacy-archived');
    await clearPointer(fx.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: home.id }, data: { archivedAt: new Date() } });

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: null, reason: 'root_selected' });
  });

  it('is NOT consulted while a pointer is set — the pointer is authoritative', async () => {
    // A project that has BOTH. The pointer wins, which is the ordering the whole
    // story turns on: otherwise the legacy title would quietly outrank the
    // destination a team configured.
    const fx = await makeProject('both');
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: fx.containerId, reason: 'configured' });
  });

  it('is PROJECT-scoped — a same-titled home in another project is never adopted', async () => {
    const fx = await makeProject('scoped');
    const neighbour = await makeProject('scoped-nbr');
    await clearPointer(fx.projectId);
    await workItemsService.createWorkItem(
      { projectId: neighbour.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      neighbour.ctx,
    );

    const result = await bugDestinationService.resolve(fx.projectId, fx.workspaceId);

    expect(result).toEqual({ parentId: null, reason: 'root_selected' });
  });
});

describe('the project itself', () => {
  it('throws ProjectNotFoundError for a project that does not exist', async () => {
    const fx = await makeProject('missing');
    await expect(
      bugDestinationService.resolve('cmzzzzzzzzzzzzzzzzzzzzzzzz', fx.workspaceId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
