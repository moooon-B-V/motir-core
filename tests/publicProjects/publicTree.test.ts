import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../helpers/db';

// Story 6.14 · Subtask 6.14.10 — the PUBLIC, expandable work-item TREE. The
// hierarchy is the surface 6.14.5 / 6.14.6 / 6.14.9 assume. The load-bearing
// guarantee under test: a public / non-member viewer can expand the tree but
// NEVER receives a private epic's children — server-side, at the PAYLOAD level —
// while a project MEMBER reads the full hierarchy. Plus the lazy-level shape
// (roots → children, `hasChildren`, `total`) the client renders. Real Postgres,
// no DB mocks; the truncate helper CASCADE-resets between tests.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function setStatus(id: string, status = 'todo'): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

async function setPrivate(epicId: string, value: boolean): Promise<void> {
  await db.workItem.update({ where: { id: epicId }, data: { publicChildrenHidden: value } });
}

async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

/**
 * The standard tree under a public project:
 *   - privateEpic (marked private)
 *       └ privStory └ privTask   (descendants that must be hidden from a non-member)
 *   - openEpic
 *       └ openStory              (a normal subtree — always visible)
 */
async function buildTree(fx: WorkItemFixture) {
  const privateEpic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic' });
  const privStory = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hidden story',
    parentId: privateEpic.id,
  });
  const privTask = await createTestWorkItem(fx, {
    kind: 'task',
    title: 'Hidden task',
    parentId: privStory.id,
  });
  const openEpic = await createTestWorkItem(fx, { kind: 'epic', title: 'Open epic' });
  const openStory = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Visible story',
    parentId: openEpic.id,
  });
  for (const w of [privateEpic, privStory, privTask, openEpic, openStory]) await setStatus(w.id);
  await setPrivate(privateEpic.id, true);
  return { privateEpic, privStory, privTask, openEpic, openStory };
}

describe('publicProjectsService.getProjectTreeLevel — a non-member browses but never sees a private subtree', () => {
  it('roots level: both epics are roots; the private epic is MARKED + reports hasChildren=false; the open epic reports hasChildren=true', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    const level = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      null,
      nonMember.id,
    );
    const byId = new Map(level.rows.map((r) => [r.id, r]));

    // Roots = the two epics (the hidden story/task are NOT roots, and are excluded anyway).
    expect(byId.has(t.privateEpic.id)).toBe(true);
    expect(byId.has(t.openEpic.id)).toBe(true);
    expect(byId.has(t.privStory.id)).toBe(false);
    expect(level.total).toBe(2);
    expect(level.hasMore).toBe(false);

    // The private epic: marked, parentId null, NO public children (its subtree is excluded).
    const priv = byId.get(t.privateEpic.id)!;
    expect(priv.childrenHidden).toBe(true);
    expect(priv.parentId).toBeNull();
    expect(priv.hasChildren).toBe(false);
    // The open epic: not marked, HAS a public child.
    const open = byId.get(t.openEpic.id)!;
    expect(open.childrenHidden).toBeUndefined();
    expect(open.hasChildren).toBe(true);

    // The public projection strips internal fields — they are absent from the row.
    expect(priv).not.toHaveProperty('assigneeId');
    expect(priv).not.toHaveProperty('estimateMinutes');
    expect(priv).not.toHaveProperty('storyPoints');
  });

  it('children level: the OPEN epic yields its child; the PRIVATE epic yields NOTHING (defence-in-depth behind the marker-driven UI)', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    const openChildren = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      t.openEpic.id,
      nonMember.id,
    );
    expect(openChildren.rows.map((r) => r.id)).toEqual([t.openStory.id]);
    expect(openChildren.total).toBe(1);

    // Even a DIRECT child-level fetch for the private epic returns nothing — its
    // descendants are excluded server-side, so no leak is possible via the API.
    const privChildren = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      t.privateEpic.id,
      nonMember.id,
    );
    expect(privChildren.rows).toEqual([]);
    expect(privChildren.total).toBe(0);
  });
});

describe('publicProjectsService.getProjectTreeLevel — member bypass + the no-op cases', () => {
  it('a project MEMBER expands the private epic and reads its children, with NO marker', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);

    const roots = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      null,
      fx.ownerId,
    );
    const priv = roots.rows.find((r) => r.id === t.privateEpic.id)!;
    expect(priv.childrenHidden).toBeUndefined();
    expect(priv.hasChildren).toBe(true); // the member sees real children → chevron

    const privChildren = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      t.privateEpic.id,
      fx.ownerId,
    );
    expect(privChildren.rows.map((r) => r.id)).toEqual([t.privStory.id]);
    expect(privChildren.total).toBe(1);
    // And the story's own child is reachable a level deeper.
    const storyChildren = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      t.privStory.id,
      fx.ownerId,
    );
    expect(storyChildren.rows.map((r) => r.id)).toEqual([t.privTask.id]);
  });

  it('unsetting the flag re-reveals the subtree to a non-member (the toggle drives enforcement live)', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    // Private: the epic reports no public children + the marker.
    let roots = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      null,
      nonMember.id,
    );
    expect(roots.rows.find((r) => r.id === t.privateEpic.id)?.hasChildren).toBe(false);

    await setPrivate(t.privateEpic.id, false);

    roots = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      null,
      nonMember.id,
    );
    const priv = roots.rows.find((r) => r.id === t.privateEpic.id)!;
    expect(priv.childrenHidden).toBeUndefined();
    expect(priv.hasChildren).toBe(true);
    const children = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      t.privateEpic.id,
      nonMember.id,
    );
    expect(children.rows.map((r) => r.id)).toContain(t.privStory.id);
  });

  it('a NON-PUBLIC project is unreachable (404) — the tree read runs the same browse gate', async () => {
    const fx = await makeWorkItemFixture({ name: 'Private Co' }); // NOT public
    await buildTree(fx);
    const nonMember = await createTestUser();

    await expect(
      publicProjectsService.getProjectTreeLevel(fx.projectIdentifier, null, nonMember.id),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('workItemRepository public tree level — the excludeIds predicate', () => {
  it('countPublicProjectTreeLevel excludes hidden descendants from a level total', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const hidden = await workItemRepository.findPublicHiddenDescendantIds(
      fx.projectId,
      fx.workspaceId,
    );

    // The private STORY's child level: with the exclusion the task is gone (0),
    // without it (a member, []), the task is counted (1).
    const excludedCount = await workItemRepository.countPublicProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      t.privStory.id,
      hidden,
    );
    expect(excludedCount).toBe(0);
    const memberCount = await workItemRepository.countPublicProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      t.privStory.id,
      [],
    );
    expect(memberCount).toBe(1);
  });
});
