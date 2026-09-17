import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';

// MOTIR-5474 — `ciState` REACHES both reads, on real Postgres.
//
// ⚠️ THIS IS THE TEST THE CARD ASKED FOR BY NAME, AND THE REASON IS A SILENT
// FAILURE MODE. Neither of these reads is a Prisma `findMany` over the whole row:
// both are `$queryRaw` with a FIXED projection, so a column left out of the
// SELECT list arrives as `undefined` at the mapper while the row type cheerfully
// claims `string | null`. Nothing goes red — the DTO simply carries `undefined`,
// every component reads it as "no badge", and the feature is silently inert.
//
// The board is the second half and fails differently: it reads whole `WorkItem`
// rows, so the column arrives for free — but its status CATEGORY does not, and
// the badge rule needs it. That is resolved from the workflow the projection
// already loads, so this asserts BOTH halves of the board card's inputs.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Proj User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Proj WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id };
}

/** A work item whose stored `ciState` is set directly — the recompute that writes
 *  it for real is MOTIR-5470's, and this test is about the READS. */
async function itemWithCiState(fx: Fixture, title: string, ciState: string | null) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { ciState } });
  return item;
}

describe('ciState reaches the board projection and the list read (MOTIR-5474)', () => {
  it('the BOARD projection carries ciState AND the status category', async () => {
    const fx = await makeFixture('board-ci@example.com');
    const item = await itemWithCiState(fx, 'A red card', 'failing');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === item.id);

    expect(card).toBeDefined();
    expect(card!.ciState).toBe('failing');
    // The category the badge rule turns on, resolved server-side from the
    // workflow the projection already loaded — the client never re-derives it.
    expect(card!.statusCategory).toBe('todo');
  });

  it('the LIST read carries ciState — the fixed SELECT actually names the column', async () => {
    const fx = await makeFixture('list-ci@example.com');
    const item = await itemWithCiState(fx, 'A red row', 'failing');

    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    const row = list.items.find((i) => i.id === item.id);

    expect(row).toBeDefined();
    // ⚠️ `toBe('failing')`, never `toBeTruthy()`: a column dropped from the raw
    // projection arrives as `undefined`, and a loose assertion would pass on a
    // read that silently returns nothing.
    expect(row!.ciState).toBe('failing');
  });

  it('carries a NULL ciState as null rather than undefined', async () => {
    // The distinction is the whole point of the assertion above. `null` means "no
    // checks" and is a real answer the badge rule reads; `undefined` means the
    // read dropped the column, and the two are indistinguishable downstream.
    const fx = await makeFixture('null-ci@example.com');
    const item = await itemWithCiState(fx, 'A card with no checks', null);

    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    const row = list.items.find((i) => i.id === item.id);
    expect(row).toBeDefined();
    expect(row!.ciState).toBeNull();
    expect('ciState' in row!).toBe(true);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === item.id);
    expect(card!.ciState).toBeNull();
  });

  it('the board and the list AGREE about one item', async () => {
    // Two reads, two projections, one column — a divergence here is exactly what
    // would make the board and `/items` disagree about whether a card is red.
    const fx = await makeFixture('agree-ci@example.com');
    const item = await itemWithCiState(fx, 'A running card', 'running');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === item.id);
    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    const row = list.items.find((i) => i.id === item.id);

    expect(card!.ciState).toBe('running');
    expect(row!.ciState).toBe(card!.ciState);
  });
});
