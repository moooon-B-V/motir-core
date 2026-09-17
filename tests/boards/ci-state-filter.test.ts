import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { FilterAst, FilterOperatorId } from '@/lib/filters/ast';
import { CI_STATES } from '@/lib/github/prCiState';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-5473 — THE BOARD READ WITH THE SAME AST RETURNS THE SAME CARDS.
//
// ⚠️ THIS IS THE TEST FOR THE HALF OF THE CARD THAT NEEDED NO CODE, WHICH IS
// exactly why it needs a test. The card's claim is that the Checks field reaches
// the board for free: the board filter resolves through `resolveFilterAst` and
// compiles through the same `compileFilterConditionsSql` the `/items` list uses,
// so `FILTER_FIELD_COLUMN_SQL.ciState` serves both. Nothing in `boardsService`
// mentions the field, and an untested "it works by construction" is a claim
// about a shared path, not an observation of it — the two reads project
// DIFFERENTLY (whole rows per column vs. one fixed `$queryRaw`), which is the
// seam where a shared predicate can still diverge.
//
// So both reads are driven with the SAME ast object and compared as SETS.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Checks User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Checks WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  return { ctx, projectId: project.id };
}

/** A card in `status` whose stored `ciState` is stamped directly — the recompute
 *  that writes it for real is MOTIR-5470's; this is about the READS. */
async function card(
  fx: Fixture,
  title: string,
  status: string,
  ciState: string | null,
): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { status, ciState } });
  return item.identifier;
}

const ast = (operator: FilterOperatorId, value: string[] | null): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'ciState', operator, value }],
});

async function boardIdentifiers(fx: Fixture, filter: FilterAst): Promise<string[]> {
  const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, { ast: filter });
  return board.columns.flatMap((c) => c.cards.map((card) => card.identifier)).sort();
}

async function listIdentifiers(fx: Fixture, filter: FilterAst): Promise<string[]> {
  const page = await workItemsService.getProjectIssuesList(
    fx.projectId,
    { sort: DEFAULT_SORT, filter: { ast: filter } },
    fx.ctx,
  );
  return page.items.map((item) => item.identifier).sort();
}

/** The four cards, deliberately spread ACROSS COLUMNS: the board reads per
 *  column, so a predicate applied to only one column's read would still agree
 *  with the list if every card sat in the same column. */
async function seed(fx: Fixture) {
  return {
    failing: await card(fx, 'Red card', 'todo', 'failing'),
    running: await card(fx, 'Running card', 'in_progress', 'running'),
    passing: await card(fx, 'Green card', 'in_review', 'passing'),
    none: await card(fx, 'No checks', 'done', null),
  };
}

describe('the Checks filter applies to the BOARD with no board code (MOTIR-5473)', () => {
  it('board and list agree, card for card, on every operator the field offers', async () => {
    const fx = await makeFixture('board-checks@example.com');
    const ids = await seed(fx);

    const cases: Array<{ filter: FilterAst; want: string[] }> = [
      { filter: ast('is_any_of', ['failing']), want: [ids.failing] },
      { filter: ast('is_any_of', ['failing', 'running']), want: [ids.failing, ids.running] },
      // ⚠️ `is_none_of` over a NULLABLE column keeps the null row — the empty
      // bucket is not "some other value", and this is the cell a naive
      // `<> 'failing'` gets wrong in SQL.
      { filter: ast('is_none_of', ['failing']), want: [ids.running, ids.passing, ids.none] },
      { filter: ast('is_empty', null), want: [ids.none] },
      { filter: ast('is_not_empty', null), want: [ids.failing, ids.running, ids.passing] },
    ];

    for (const { filter, want } of cases) {
      const fromBoard = await boardIdentifiers(fx, filter);
      const fromList = await listIdentifiers(fx, filter);
      const label = `${filter.conditions[0]!.operator} ${JSON.stringify(filter.conditions[0]!.value)}`;
      expect(fromList, `the LIST read, ${label}`).toEqual([...want].sort());
      expect(fromBoard, `the BOARD read, ${label}`).toEqual(fromList);
    }
  });

  it('filters the board RAW — a done card with a failing column still matches', async () => {
    // The badge's done-category rule is a DRAWING rule and deliberately not
    // shared with the filter (the registry comment says so): a saved view that
    // silently dropped done cards would be the worse failure. A `done` card
    // reading `failing` is therefore returned by both reads.
    const fx = await makeFixture('board-checks-done@example.com');
    const done = await card(fx, 'Old red, finished', 'done', 'failing');
    const open = await card(fx, 'Red, open', 'todo', 'failing');

    const filter = ast('is_any_of', ['failing']);
    expect(await listIdentifiers(fx, filter)).toEqual([done, open].sort());
    expect(await boardIdentifiers(fx, filter)).toEqual([done, open].sort());
  });

  it("narrows the board's per-column totalCount, not just its visible cards", async () => {
    // The board's cap/`truncated` arithmetic reads `totalCount`, which is its
    // own filtered COUNT query rather than `cards.length` — a predicate that
    // reached the card read but not the count would leave a column claiming
    // more cards than it can show.
    const fx = await makeFixture('board-checks-count@example.com');
    await card(fx, 'Red', 'todo', 'failing');
    await card(fx, 'Green', 'todo', 'passing');
    await card(fx, 'Quiet', 'todo', null);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: ast('is_any_of', ['failing']),
    });
    const todo = board.columns.find((c) => c.statusKeys.includes('todo'))!;
    expect(todo.cards).toHaveLength(1);
    expect(todo.totalCount).toBe(1);
  });

  it('every value the FOLD can write is filterable on the board — the set is not a subset', async () => {
    // Derived from `CI_STATES` (the tuple MOTIR-5470's fold writes from) rather
    // than typed out, so a fourth verdict added there fails HERE instead of
    // silently becoming a value nobody can search for.
    const fx = await makeFixture('board-checks-total@example.com');
    const byState = new Map<string, string>();
    for (const state of CI_STATES) {
      byState.set(state, await card(fx, `A ${state} card`, 'todo', state));
    }

    for (const state of CI_STATES) {
      expect(await boardIdentifiers(fx, ast('is_any_of', [state]))).toEqual([byState.get(state)]);
    }
  });
});
