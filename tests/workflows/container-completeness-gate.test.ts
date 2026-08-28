import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { IllegalBoardMoveError } from '@/lib/boards/errors';
import { ContainerHasOpenChildrenError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// THE CONTAINER-COMPLETENESS GATE (Bug MOTIR-3229) at the seam it guards:
// `applyStatusTransition`, which every close-out passes through — the detail
// page, the board drag, the v1 route, the MCP `transition_status` and the
// CI-green promotion.
//
// ── WHAT HAPPENED, and why the gate is HERE ────────────────────────────────
// MOTIR-1343 reached `implemented`, then In Review, then Done — carrying two
// merged pull requests — while two of its direct children sat at `todo` the
// whole time. The derivation run that fired 15 s after the `implemented` move
// returned `rollup: already_there` / `cascade: not_done`: both directions doing
// exactly what they are specified to do, and NEITHER looking down at the
// transitioning item's own children. The upward direction rolls up the item's
// PARENT; the downward cascade fires only on entry into a done-category status.
// No trigger exists that would ever contradict such a claim, so a rung change
// alone could not fix it — the question has to be asked AT the transition.
//
// The ladder's own five rungs are exercised in
// `tests/integration/workflows/parentStatusRollup.test.ts`; the aggregate's
// buckets in `childrenStatusAggregate.test.ts`; the cascade's defect-report
// exemption in `childStatusCascade.test.ts`. What is proven HERE is the refusal:
// that it fires on a real transition, leaves the row untouched, names the open
// children, spares a leaf, spares `done`, and spares the system lane.
//
// Real Postgres, per the repo convention.

beforeEach(async () => {
  // The transition paths emit `work-item/transitioned` post-commit (5.4.5) and
  // the test env has no Inngest key.
  spyOnJobDispatch();
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
  storyId: string;
  childIds: string[];
}

let seq = 0;

/**
 * A story parked at `in_progress` over children in the given statuses — the
 * shape a story run is in when it decides it is finished.
 *
 * Child statuses are written through the ADMIN client rather than the workflow,
 * because these tests exercise the GATE, not the transition graph: a child at
 * `todo` is the whole point of the fixture and there is no legal path that
 * leaves it there after a run.
 */
async function makeStory(childStatuses: string[]): Promise<Fixture> {
  seq += 1;
  const user = await usersService.createUser({
    email: `cc-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'CC User',
  });
  const ws = await workspacesService.createWorkspace({
    name: `CC WS ${seq}`,
    ownerUserId: user.id,
  });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: `Story ${seq}` },
    ctx,
  );
  const childIds: string[] = [];
  for (const [i, status] of childStatuses.entries()) {
    const child = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'subtask', title: `child ${i}`, parentId: story.id },
      ctx,
    );
    await adminDb.workItem.update({ where: { id: child.id }, data: { status } });
    childIds.push(child.id);
  }
  await workItemsService.updateStatus(story.id, 'in_progress', ctx);
  return { ctx, projectId: project.id, storyId: story.id, childIds };
}

async function statusOf(fx: Fixture, id = fx.storyId): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** A minimal per-status board for the project, for the drag path. */
async function makeBoard(fx: Fixture, columnForKey: string) {
  const { workspaceId } = fx.ctx;
  const statuses = await workflowsService.listStatusesByProject(fx.projectId, workspaceId);
  const board = await adminDb.board.create({
    data: { workspaceId, projectId: fx.projectId, name: 'Board', type: 'kanban', position: 'a0' },
  });
  let targetColumnId = '';
  let n = 0;
  for (const status of statuses) {
    n += 1;
    const column = await adminDb.boardColumn.create({
      data: {
        workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        name: status.label,
        position: `c${n.toString(36)}`,
      },
    });
    await adminDb.boardColumnStatus.create({
      data: {
        workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        columnId: column.id,
        statusId: status.id,
      },
    });
    if (status.key === columnForKey) targetColumnId = column.id;
  }
  return { boardId: board.id, targetColumnId };
}

describe('a container cannot CLAIM it is built while a child is not', () => {
  it('REFUSES `implemented` and leaves the row exactly where it was', async () => {
    // ⭐ MOTIR-1343's 11:24:59, at the seam. Two children built, two at `todo`.
    const fx = await makeStory(['implemented', 'implemented', 'todo', 'todo']);

    await expect(workItemsService.updateStatus(fx.storyId, 'implemented', fx.ctx)).rejects.toThrow(
      ContainerHasOpenChildrenError,
    );
    // The refusal precedes the write, so this is not merely "the status is
    // wrong" — nothing about the row moved.
    expect(await statusOf(fx)).toBe('in_progress');
  });

  it('REFUSES `in_review` too — the status the PR gate keys on', async () => {
    // Point 4 of the card: In Review is a promise to a person, and MOTIR-1343
    // reached it 6 minutes after `implemented` with the same two `todo` children.
    const fx = await makeStory(['done', 'todo']);

    await expect(workItemsService.updateStatus(fx.storyId, 'in_review', fx.ctx)).rejects.toThrow(
      ContainerHasOpenChildrenError,
    );
    expect(await statusOf(fx)).toBe('in_progress');
  });

  it('NAMES the open children, so the fix is one hop', async () => {
    // The whole failure this closes is that nobody looked at the child set. An
    // error saying "children are open" would leave the reader to go and find
    // which; MOTIR-3218 and MOTIR-3219 had to be reconstructed from a job log.
    const fx = await makeStory(['todo', 'implemented', 'in_progress']);
    const open = await adminDb.workItem.findMany({
      where: { id: { in: [fx.childIds[0]!, fx.childIds[2]!] } },
      select: { identifier: true },
    });

    const err = await workItemsService
      .updateStatus(fx.storyId, 'implemented', fx.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContainerHasOpenChildrenError);
    const typed = err as ContainerHasOpenChildrenError;
    expect([...typed.openChildren].sort()).toEqual(open.map((o) => o.identifier).sort());
    for (const { identifier } of open) expect(typed.message).toContain(identifier);
  });

  it('a `blocked` or `planning` child is BELOW the bar — neither is built', async () => {
    // `planning` sits in the `in_progress` CATEGORY (MOTIR-2425) and `blocked` in
    // `todo`, so a rule reading categories alone would let `planning` through. The
    // bar is the LADDER RANK, and neither reaches `implemented`.
    for (const status of ['blocked', 'planning']) {
      const fx = await makeStory([status]);
      await expect(
        workItemsService.updateStatus(fx.storyId, 'implemented', fx.ctx),
      ).rejects.toThrow(ContainerHasOpenChildrenError);
    }
  });
});

describe('what the gate deliberately does NOT refuse', () => {
  it('ALLOWS the claim once every child is implemented-or-better', async () => {
    const fx = await makeStory(['implemented', 'in_review', 'done', 'cancelled']);

    expect((await workItemsService.updateStatus(fx.storyId, 'implemented', fx.ctx)).status).toBe(
      'implemented',
    );
  });

  it('never touches a LEAF — the common transition pays nothing', async () => {
    const fx = await makeStory([]);
    expect((await workItemsService.updateStatus(fx.storyId, 'implemented', fx.ctx)).status).toBe(
      'implemented',
    );
  });

  it('ignores an ARCHIVED child — it is not in the live child set', async () => {
    const fx = await makeStory(['todo']);
    await adminDb.workItem.update({
      where: { id: fx.childIds[0]! },
      data: { archivedAt: new Date() },
    });

    expect((await workItemsService.updateStatus(fx.storyId, 'implemented', fx.ctx)).status).toBe(
      'implemented',
    );
  });

  it('lets `done` through — completing a parent COMPLETES its children, by design', async () => {
    // §4's downward cascade is the shipped expression of "the parent is done, so
    // its children are done". Gating it here would break the feature rather than
    // the defect — which is why the cascade instead grew an exemption for the one
    // child kind it must not sweep.
    const fx = await makeStory(['todo', 'todo']);
    await workItemsService.updateStatus(fx.storyId, 'in_review', fx.ctx).catch(() => {});
    // Straight from in_progress, the edge MOTIR-1625 added.
    expect((await workItemsService.updateStatus(fx.storyId, 'done', fx.ctx)).status).toBe('done');
  });

  it('lets `blocked` and a move BACK through — only the two claim rungs are gated', async () => {
    const fx = await makeStory(['todo']);
    expect((await workItemsService.updateStatus(fx.storyId, 'blocked', fx.ctx)).status).toBe(
      'blocked',
    );
    expect((await workItemsService.updateStatus(fx.storyId, 'todo', fx.ctx)).status).toBe('todo');
  });

  it('exempts the SYSTEM lane — a background write must not fail on a business rule', async () => {
    // The importer, the downward cascade and the rollup's backward arm all run
    // behind a change somebody already made successfully. The forward rollup arm
    // is NOT system and needs no exemption: it only ever targets a rung its
    // children actually match.
    const fx = await makeStory(['todo']);
    expect((await workItemsService.setImportedStatus(fx.storyId, 'in_review', fx.ctx)).status).toBe(
      'in_review',
    );
  });
});

describe('the refusal message', () => {
  it('names the children, caps the list at five, and counts the rest', () => {
    // A container can have many open children, and a refusal that pastes forty
    // keys is a refusal nobody reads. Five plus a count is enough to act on and
    // short enough to land in a board snapback reason or a CLI line.
    const err = new ContainerHasOpenChildrenError('implemented', [
      'MOTIR-1',
      'MOTIR-2',
      'MOTIR-3',
      'MOTIR-4',
      'MOTIR-5',
      'MOTIR-6',
      'MOTIR-7',
    ]);
    expect(err.message).toContain('7 of its children');
    expect(err.message).toContain('MOTIR-5');
    expect(err.message).toContain('(+2 more)');
    expect(err.message).not.toContain('MOTIR-6');
    expect(err.code).toBe('CONTAINER_HAS_OPEN_CHILDREN');
  });

  it('reads in the singular for one child', () => {
    const err = new ContainerHasOpenChildrenError('in_review', ['MOTIR-3218']);
    expect(err.message).toContain('1 of its children has not been implemented');
    expect(err.message).not.toContain('more)');
  });
});

describe('the board SNAPS BACK rather than 500-ing', () => {
  it('dragging a story with open children into Implemented is a board-shaped refusal', async () => {
    // The drag is how a person actually moves a card, so this path must reach the
    // 409 the 3.2 UI branches on — not an opaque internal error. The reason
    // carries the whole refusal, so the card returns to its column naming the
    // children that are not landed.
    const fx = await makeStory(['todo']);
    const { boardId, targetColumnId } = await makeBoard(fx, 'implemented');
    const child = await adminDb.workItem.findUniqueOrThrow({
      where: { id: fx.childIds[0]! },
      select: { identifier: true },
    });

    const err = await boardsService
      .moveCard(boardId, fx.storyId, { toColumnId: targetColumnId }, fx.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IllegalBoardMoveError);
    expect((err as IllegalBoardMoveError).reason).toContain(child.identifier);
    expect(await statusOf(fx)).toBe('in_progress');
  });
});
