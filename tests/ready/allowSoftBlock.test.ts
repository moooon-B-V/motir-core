import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { seedBlockedBy } from '../helpers/seedBlockedBy';

// `allowSoftBlock` on the ready READ (Story MOTIR-6354 · MOTIR-6366), at the
// SERVICE tier, over real Postgres.
//
// A HARD block is a leaf's OWN open `blocked_by`; a SOFT block is one it only
// inherits, because an ancestor is not ready. The flag widens `listReady` past
// the soft kind and never past the hard one — and it is LIST-only: the three
// dispatch reads (`getNextReady` / `countReady` / `claimNextReady`) do not take
// it, which the `@ts-expect-error` lines below hold at compile time.
//
// The fixture every case here reads:
//
//   gateEpic (open)                      epic (blocked_by gateEpic — OPEN)
//     └── otherStory                       └── story
//           └── openSubtask (todo)               ├── freeSubtask   ← SOFT-blocked only
//                                                └── heldSubtask   ← blocked_by openSubtask (HARD)

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function make(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'subtask',
  title: string,
  parentId?: string,
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

async function block(fx: WorkItemFixture, fromId: string, toId: string) {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

async function buildFixture() {
  const fx = await makeWorkItemFixture();
  const gateEpic = await make(fx, 'epic', 'Gate epic');
  const otherStory = await make(fx, 'story', 'Other story', gateEpic.id);
  const openSubtask = await make(fx, 'subtask', 'Open subtask elsewhere', otherStory.id);

  const epic = await make(fx, 'epic', 'Blocked epic');
  await block(fx, epic.id, gateEpic.id);
  const story = await make(fx, 'story', 'Story under the blocked epic', epic.id);
  const freeSubtask = await make(fx, 'subtask', 'Own blockers satisfied', story.id);
  const heldSubtask = await make(fx, 'subtask', 'Own blocker open', story.id);
  await block(fx, heldSubtask.id, openSubtask.id);

  return { fx, gateEpic, otherStory, openSubtask, epic, story, freeSubtask, heldSubtask };
}

async function readyKeys(
  fx: WorkItemFixture,
  filter: Parameters<typeof workItemsService.listReady>[1] = {},
): Promise<string[]> {
  const { items } = await workItemsService.listReady(fx.projectId, filter, fx.ctx);
  return items.map((i) => i.key);
}

describe('listReady — allowSoftBlock', () => {
  it('ABSENT or false: the soft-blocked subtask is absent, exactly as before the flag', async () => {
    const { fx, openSubtask, freeSubtask, heldSubtask } = await buildFixture();

    const absent = await readyKeys(fx);
    const off = await readyKeys(fx, { allowSoftBlock: false });

    expect(absent).toEqual([openSubtask.identifier]);
    expect(off).toEqual(absent);
    expect(absent).not.toContain(freeSubtask.identifier);
    expect(absent).not.toContain(heldSubtask.identifier);
  });

  it('true: lists the leaf held only by an ancestor, never the one with its own open blocker', async () => {
    const { fx, epic, story, openSubtask, freeSubtask, heldSubtask } = await buildFixture();

    const keys = await readyKeys(fx, { allowSoftBlock: true });

    expect(new Set(keys)).toEqual(new Set([openSubtask.identifier, freeSubtask.identifier]));
    // HARD: its own blocker lives in ANOTHER story and is open.
    expect(keys).not.toContain(heldSubtask.identifier);
    // A soft-blocking container is descended, never collected — it has children.
    expect(keys).not.toContain(epic.identifier);
    expect(keys).not.toContain(story.identifier);
  });

  it('true + ancestor: the story’s own-ready children when only its epic is blocked', async () => {
    const { fx, story, freeSubtask } = await buildFixture();

    expect(await readyKeys(fx, { ancestorKeys: [story.identifier] })).toEqual([]);
    expect(await readyKeys(fx, { ancestorKeys: [story.identifier], allowSoftBlock: true })).toEqual(
      [freeSubtask.identifier],
    );
  });

  it('true: a CHILDLESS container with its own open blocker is a leaf, and stays excluded', async () => {
    // The container exemption is for NON-leaf rows only: a childless story is a
    // dispatchable leaf ("ready to plan"), so its own blocker is a HARD block.
    const { fx, openSubtask } = await buildFixture();
    const bareStory = await make(fx, 'story', 'Childless and blocked');
    // A root story on a subtask crosses levels, which the link door refuses
    // (MOTIR-6411); readiness still meets such edges, so it is seeded.
    await seedBlockedBy(fx, bareStory.id, openSubtask.id);

    expect(await readyKeys(fx, { allowSoftBlock: true })).not.toContain(bareStory.identifier);
  });
});

describe('the dispatch reads do NOT take allowSoftBlock', () => {
  it('countReady / getNextReady / claimNextReady answer the unwidened set', async () => {
    const { fx, openSubtask } = await buildFixture();

    // @ts-expect-error — `countReady`'s filter Omits `allowSoftBlock` (MOTIR-6366).
    const count = await workItemsService.countReady(fx.projectId, { allowSoftBlock: true }, fx.ctx);
    expect(count).toEqual({ count: 1, hasMore: false });

    const next = await workItemsService.getNextReady(
      fx.projectId,
      // @ts-expect-error — `getNextReady`'s filter Omits `allowSoftBlock` (MOTIR-6366).
      { allowSoftBlock: true, excludeIds: [openSubtask.id] },
      fx.ctx,
    );
    // The only unwidened ready leaf is excluded, so nothing is left — the
    // soft-blocked subtask is NOT offered in its place.
    expect(next).toBeNull();

    // `claimNextReady(projectId, sprintId, ctx)` has no filter at all.
    expect(workItemsService.claimNextReady.length).toBe(3);
  });
});
