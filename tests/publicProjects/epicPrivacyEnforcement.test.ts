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

// Story 6.14 · Subtask 6.14.4 — the SERVER-SIDE epic-privacy enforcement. A
// private epic's children + its aggregate tells must NEVER be transmitted to a
// public / non-member viewer by ANY public read, while a project MEMBER reads
// them unchanged. Real Postgres, no DB mocks; the truncate helper CASCADE-resets
// between tests. Asserted at the PAYLOAD level (the DTO the read returns), not
// the DOM — the no-leak guarantee is "the child is never SELECTed into the
// response", not "hidden client-side".
//
// Architecture note: the ONLY surface a non-member can reach on a public project
// is `publicProjectsService` (the `/p/[identifier]` board + items + overview).
// The internal `workItemsService` tree / detail / ready / search reads are
// workspace-scoped — a cross-org non-member 404s there and a member bypasses —
// so the public projection is the complete attack surface, and these tests cover
// every live public read that transmits a work item to a non-member.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Set a work item's status key directly (a read test doesn't transition). The
 *  default `status` is "open" — not a default-workflow key — so the board/stats
 *  reads need a real key ('todo' → To Do column, `todo` category). */
async function setStatus(id: string, status = 'todo'): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

/** Flip an epic's privacy flag the way the 6.14.7 admin write will — the column
 *  the 6.14.4 exclusion predicate reads. */
async function setPrivate(epicId: string, value: boolean): Promise<void> {
  await db.workItem.update({ where: { id: epicId }, data: { publicChildrenHidden: value } });
}

/** A fixture whose project is PUBLIC (the make-public toggle is 6.12.8; tests set
 *  the column directly, the shortcut the other public-project tests use). */
async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

/**
 * Build the standard tree under a public project:
 *   - privateEpic  (will be marked private)
 *       └ privStory └ privTask   (the descendants that must be hidden)
 *   - openEpic
 *       └ openStory              (a normal subtree — must stay visible)
 * All statuses set to 'todo' so they land in the To Do board column + the
 * Planned stat bucket.
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
  for (const w of [privateEpic, privStory, privTask, openEpic, openStory]) {
    await setStatus(w.id);
  }
  await setPrivate(privateEpic.id, true);
  return { privateEpic, privStory, privTask, openEpic, openStory };
}

describe('workItemRepository.findPublicHiddenDescendantIds', () => {
  it('returns every descendant of a private epic (depth-agnostic), but NOT the epic row itself', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);

    const hidden = await workItemRepository.findPublicHiddenDescendantIds(
      fx.projectId,
      fx.workspaceId,
    );

    // The story (depth 2) AND the task under it (depth 3) are both hidden.
    expect(new Set(hidden)).toEqual(new Set([t.privStory.id, t.privTask.id]));
    // The private epic ROW stays (it is the visible placeholder), and the open
    // subtree is untouched.
    expect(hidden).not.toContain(t.privateEpic.id);
    expect(hidden).not.toContain(t.openEpic.id);
    expect(hidden).not.toContain(t.openStory.id);
  });

  it('returns [] for a project with no private epic', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    await setPrivate(t.privateEpic.id, false);
    expect(
      await workItemRepository.findPublicHiddenDescendantIds(fx.projectId, fx.workspaceId),
    ).toEqual([]);
  });
});

describe('publicProjectsService — non-member cannot read a private epic’s children via ANY public read', () => {
  it('getWorkItems: the items payload EXCLUDES the hidden subtree and MARKS the private epic row', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser(); // cross-org: not a member of fx.workspace

    const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id);
    const byId = new Map(page.items.map((i) => [i.id, i]));

    // The hidden descendants are ABSENT from the payload (not just the DOM).
    expect(byId.has(t.privStory.id)).toBe(false);
    expect(byId.has(t.privTask.id)).toBe(false);
    // The private epic ROW is present, carrying the "children-hidden" marker.
    expect(byId.get(t.privateEpic.id)?.childrenHidden).toBe(true);
    // The open subtree is fully visible, with no marker on the open epic.
    expect(byId.has(t.openStory.id)).toBe(true);
    expect(byId.get(t.openEpic.id)?.childrenHidden).toBeUndefined();
  });

  it('getBoard: the column cards EXCLUDE the hidden subtree, the epic card is marked, and the denominator is stripped', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    const board = await publicProjectsService.getBoard(fx.projectIdentifier, nonMember.id);
    const cards = board.columns.flatMap((c) => c.cards);
    const cardIds = new Set(cards.map((c) => c.id));

    expect(cardIds.has(t.privStory.id)).toBe(false);
    expect(cardIds.has(t.privTask.id)).toBe(false);
    expect(cardIds.has(t.openStory.id)).toBe(true);
    expect(cards.find((c) => c.id === t.privateEpic.id)?.childrenHidden).toBe(true);

    // The To Do column's totalCount denominator must not count the hidden
    // subtree either (the count is an aggregate tell). Visible 'todo' items =
    // privateEpic + openEpic + openStory = 3.
    const todoTotal = board.columns.reduce((sum, c) => sum + c.totalCount, 0);
    expect(todoTotal).toBe(3);
  });

  it('getOverview: the Planned stat does NOT count the hidden descendants (no aggregate-tell leak)', async () => {
    const fx = await makePublicProjectFixture();
    await buildTree(fx);
    const nonMember = await createTestUser();

    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, nonMember.id);
    // Visible 'todo' items: privateEpic + openEpic + openStory = 3 (the 2 hidden
    // descendants are excluded).
    expect(overview.stats.planned).toBe(3);
    expect(overview.stats.shipped).toBe(0);
  });

  it('the exclusion is applied to EVERY item-transmitting public read (parameterized)', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();
    const hiddenIds = [t.privStory.id, t.privTask.id];

    const reads: Array<{ name: string; ids: () => Promise<string[]> }> = [
      {
        name: 'items list',
        ids: async () =>
          (await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id)).items.map(
            (i) => i.id,
          ),
      },
      {
        name: 'board',
        ids: async () =>
          (
            await publicProjectsService.getBoard(fx.projectIdentifier, nonMember.id)
          ).columns.flatMap((c) => c.cards.map((card) => card.id)),
      },
    ];

    for (const read of reads) {
      const ids = await read.ids();
      for (const hidden of hiddenIds) {
        expect(ids, `${read.name} must not leak ${hidden}`).not.toContain(hidden);
      }
    }
  });
});

describe('publicProjectsService — member bypass + the no-op cases', () => {
  it('a project MEMBER reads the children + the real rollups, with NO marker', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);

    // The owner (a workspace member) views the public surface → full visibility.
    const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, fx.ownerId);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.has(t.privStory.id)).toBe(true);
    expect(byId.has(t.privTask.id)).toBe(true);
    expect(byId.get(t.privateEpic.id)?.childrenHidden).toBeUndefined();

    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, fx.ownerId);
    // Member sees all 5 'todo' items in the Planned bucket.
    expect(overview.stats.planned).toBe(5);
  });

  it('a NON-PUBLIC project is unreachable by a non-member (404) — the flag is inert off the public surface', async () => {
    const fx = await makeWorkItemFixture({ name: 'Private Co' }); // NOT public
    const t = await buildTree(fx);
    await setPrivate(t.privateEpic.id, true);
    const nonMember = await createTestUser();

    await expect(
      publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('unsetting the flag re-reveals the children to a non-member (the toggle drives enforcement live)', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    // Private: children hidden.
    let ids = (
      await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id)
    ).items.map((i) => i.id);
    expect(ids).not.toContain(t.privStory.id);

    // Admin unsets privacy (the 6.14.7 write) → the same non-member now sees them.
    await setPrivate(t.privateEpic.id, false);
    const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id);
    ids = page.items.map((i) => i.id);
    expect(ids).toContain(t.privStory.id);
    expect(ids).toContain(t.privTask.id);
    expect(page.items.find((i) => i.id === t.privateEpic.id)?.childrenHidden).toBeUndefined();
  });
});
