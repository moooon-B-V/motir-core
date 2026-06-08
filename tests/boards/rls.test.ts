import { Prisma, type StatusCategory } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// Row-level security + key constraints for the board tables (Story 3.1 ·
// Subtask 3.1.1) — direct-DB tenancy + integrity proof for `board` /
// `board_column` / `board_column_status`. The Story-3.1 companion to
// tests/workflows/rls.test.ts (which this mirrors).
//
// Like `workflow_status`, the board tables carry NO system-admin escape hatch:
// they are pure tenant data (non-null workspace_id, always written under an
// active workspace context), so their policy is the same pure workspace gate
// `project` / `work_item` / `workflow_status` use. This file proves:
//   * with NO context, the non-bypass role sees zero rows (safe failure mode);
//   * a W1 tenant context sees ONLY W1's boards/columns/mappings — never W2's;
//   * a cross-workspace SELECT of a foreign row returns 0 rows;
//   * WITH CHECK rejects inserting a row whose workspace_id is foreign to the
//     active context;
//   * @@unique([boardId, statusId]) enforces a status maps to ≤1 column per
//     board (a second mapping of the same status to a different column on the
//     same board is rejected);
//   * board.project_id is NOT unique — a project may own multiple boards.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE
// ROW LEVEL SECURITY. Every RLS assertion below runs inside a transaction that
// `SET LOCAL ROLE prodect_app` (the NOSUPERUSER NOBYPASSRLS role). The
// asAppRole helper binds the same GUC withWorkspaceContext binds
// (app.workspace_id) then drops the role so the policies bite; it reverts at
// txn end. Local copy of the helper, per the convention each RLS suite carries
// its own. The constraint tests (unique, non-unique projectId) run as the
// superuser via the `db` singleton — they assert DB constraints, which bite
// regardless of role.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades to project → workflow_status / board / board_column /
  // board_column_status (all FK the workspace with onDelete: Cascade), so no
  // dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

let positionCounter = 0;
function nextPosition(): string {
  // Any strictly-increasing text is a valid fractional-index `position` for
  // these fixtures (we never reorder them). Monotonic base-36 keeps them
  // unique without pulling in the positioning helper.
  positionCounter += 1;
  return `a${positionCounter.toString(36)}`;
}

// Insert a workflow_status directly (the board columns map to these). Runs as
// the superuser during fixture setup, so RLS doesn't bite here.
async function makeStatus(args: {
  workspaceId: string;
  projectId: string;
  key: string;
  category?: StatusCategory;
  isInitial?: boolean;
}): Promise<string> {
  const row = await db.workflowStatus.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      key: args.key,
      label: args.key,
      category: args.category ?? 'todo',
      position: nextPosition(),
      isInitial: args.isInitial ?? false,
    },
  });
  return row.id;
}

async function makeBoard(args: {
  workspaceId: string;
  projectId: string;
  name?: string;
}): Promise<string> {
  const row = await db.board.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      name: args.name ?? 'Board',
      position: 'a0',
    },
  });
  return row.id;
}

async function makeColumn(args: {
  workspaceId: string;
  projectId: string;
  boardId: string;
  name: string;
}): Promise<string> {
  const row = await db.boardColumn.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      boardId: args.boardId,
      name: args.name,
      position: nextPosition(),
    },
  });
  return row.id;
}

async function makeMapping(args: {
  workspaceId: string;
  projectId: string;
  boardId: string;
  columnId: string;
  statusId: string;
}): Promise<string> {
  const row = await db.boardColumnStatus.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      boardId: args.boardId,
      columnId: args.columnId,
      statusId: args.statusId,
    },
  });
  return row.id;
}

interface BoardTenantFixture {
  workspaceW1Id: string;
  workspaceW2Id: string;
  projectP1Id: string;
  projectP2Id: string;
  // W1: one board, one column, one status mapped into it.
  boardW1Id: string;
  columnW1Id: string;
  statusW1Id: string;
  mappingW1Id: string;
  // W2: one board, one column, one status mapped into it.
  boardW2Id: string;
  columnW2Id: string;
  statusW2Id: string;
  mappingW2Id: string;
}

// Two independent tenants, each a project with one board → one column → one
// mapped status. Users / workspaces are built via the real services so the
// membership + workspace context match production; board rows are inserted
// directly (the repositories/seed land in 3.1.2 / 3.1.3).
async function makeBoardTenants(): Promise<BoardTenantFixture> {
  const userA = await usersService.createUser({
    email: 'board-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Board Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'board-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Board Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'Board WS 1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'Board WS 2', ownerUserId: userB.id });
  // BARE projects (db insert, NOT projectsService.createProject) so the manual
  // board fixtures below aren't shadowed by 3.1.2's auto-seeded default board —
  // this suite controls the exact rows under test.
  const p1 = await db.project.create({
    data: { workspaceId: w1.workspace.id, name: 'Board P1', slug: 'board-rls', identifier: 'BRL' },
  });
  const p2 = await db.project.create({
    data: { workspaceId: w2.workspace.id, name: 'Board P2', slug: 'board-rls', identifier: 'BRL' },
  });

  const statusW1Id = await makeStatus({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    key: 'todo',
    category: 'todo',
    isInitial: true,
  });
  const boardW1Id = await makeBoard({ workspaceId: w1.workspace.id, projectId: p1.id });
  const columnW1Id = await makeColumn({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    boardId: boardW1Id,
    name: 'To Do',
  });
  const mappingW1Id = await makeMapping({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    boardId: boardW1Id,
    columnId: columnW1Id,
    statusId: statusW1Id,
  });

  const statusW2Id = await makeStatus({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    key: 'todo',
    category: 'todo',
    isInitial: true,
  });
  const boardW2Id = await makeBoard({ workspaceId: w2.workspace.id, projectId: p2.id });
  const columnW2Id = await makeColumn({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    boardId: boardW2Id,
    name: 'To Do',
  });
  const mappingW2Id = await makeMapping({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    boardId: boardW2Id,
    columnId: columnW2Id,
    statusId: statusW2Id,
  });

  return {
    workspaceW1Id: w1.workspace.id,
    workspaceW2Id: w2.workspace.id,
    projectP1Id: p1.id,
    projectP2Id: p2.id,
    boardW1Id,
    columnW1Id,
    statusW1Id,
    mappingW1Id,
    boardW2Id,
    columnW2Id,
    statusW2Id,
    mappingW2Id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally binds app.workspace_id and
 * (b) drops to the non-bypass prodect_app role for the duration. The role
 * switch is what makes RLS bite; it reverts at txn end.
 */
async function asAppRole<T>(
  ctx: { workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('board RLS — read isolation', () => {
  it('with NO context, prodect_app sees zero board rows', async () => {
    await makeBoardTenants();
    const rows = await asAppRole({}, (tx) => tx.board.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 context bound, only W1's board is visible — never W2's", async () => {
    const fx = await makeBoardTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) => tx.board.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.boardW1Id]);
    expect(ids).not.toContain(fx.boardW2Id);
  });

  it('a tenant cannot SELECT a foreign-workspace board (cross-workspace read returns 0 rows)', async () => {
    const fx = await makeBoardTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.board.findMany({ where: { id: fx.boardW2Id } }),
    );
    expect(rows).toEqual([]);
  });

  it("with the W1 context, only W1's columns + mappings are visible", async () => {
    const fx = await makeBoardTenants();
    const { columns, mappings } = await asAppRole(
      { workspaceId: fx.workspaceW1Id },
      async (tx) => ({
        columns: await tx.boardColumn.findMany(),
        mappings: await tx.boardColumnStatus.findMany(),
      }),
    );
    expect(columns.map((c) => c.id)).toEqual([fx.columnW1Id]);
    expect(mappings.map((m) => m.id)).toEqual([fx.mappingW1Id]);
  });
});

describe('board RLS — write isolation (WITH CHECK)', () => {
  it('a tenant can INSERT a board for its OWN workspace', async () => {
    const fx = await makeBoardTenants();
    const created = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.board.create({
        data: {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          name: 'Second Board',
          position: 'a1',
        },
      }),
    );
    expect(created.workspaceId).toBe(fx.workspaceW1Id);
  });

  it('a tenant CANNOT INSERT a board carrying a FOREIGN workspaceId (WITH CHECK rejects)', async () => {
    const fx = await makeBoardTenants();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.board.create({
          data: {
            workspaceId: fx.workspaceW2Id,
            projectId: fx.projectP2Id,
            name: 'Sneaky',
            position: 'a1',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a tenant CANNOT INSERT a board_column_status carrying a FOREIGN workspaceId', async () => {
    const fx = await makeBoardTenants();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.boardColumnStatus.create({
          data: {
            workspaceId: fx.workspaceW2Id,
            projectId: fx.projectP2Id,
            boardId: fx.boardW2Id,
            columnId: fx.columnW2Id,
            statusId: fx.statusW2Id,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('board_column_status constraints — one column per status per board', () => {
  it('mapping the SAME status to a SECOND column on the same board is rejected (@@unique([boardId, statusId]))', async () => {
    const fx = await makeBoardTenants();
    // A second column on W1's board.
    const secondColumnId = await makeColumn({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      boardId: fx.boardW1Id,
      name: 'In Progress',
    });
    // fx already mapped statusW1 → columnW1 on boardW1; mapping it again to the
    // second column on the SAME board violates the unique index.
    await expect(
      makeMapping({
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        boardId: fx.boardW1Id,
        columnId: secondColumnId,
        statusId: fx.statusW1Id,
      }),
    ).rejects.toThrow();
  });

  it('the same status MAY map to a column on a DIFFERENT board (the index is per-board)', async () => {
    const fx = await makeBoardTenants();
    // A second board in W1/P1 (legal — project_id is non-unique) with its own
    // column; mapping the same status into it must succeed.
    const secondBoardId = await makeBoard({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      name: 'Board 2',
    });
    const secondBoardColumnId = await makeColumn({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      boardId: secondBoardId,
      name: 'To Do',
    });
    const id = await makeMapping({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      boardId: secondBoardId,
      columnId: secondBoardColumnId,
      statusId: fx.statusW1Id,
    });
    expect(id).toBeTruthy();
  });
});

describe('board constraints — project_id is NOT unique', () => {
  it('a project may own multiple boards', async () => {
    const fx = await makeBoardTenants();
    // fx already created one board for P1; a second is legal at the schema
    // level (multiple-boards-per-project is a non-breaking later addition).
    const secondBoardId = await makeBoard({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      name: 'Board 2',
    });
    expect(secondBoardId).toBeTruthy();
    const count = await db.board.count({ where: { projectId: fx.projectP1Id } });
    expect(count).toBe(2);
  });
});
