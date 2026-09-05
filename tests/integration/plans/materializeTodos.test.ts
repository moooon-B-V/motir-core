import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemTodoRepository } from '@/lib/repositories/workItemTodoRepository';
import type { PlanItemProposedFields, ProposedTodoInput } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MATERIALIZE writes the rows (Story MOTIR-3810 · Subtask MOTIR-4618) —
// `docs/decisions/agent-authored-plans.md` AMENDMENT 14 D5.
//
// The carrier (MOTIR-4616) made a proposal able to HOLD a card's steps. This is
// the moment they stop being a proposal: approve creates the work item and, in
// the same transaction, one `work_item_todo` row per proposed step, in array
// order, none ticked.
//
// Real Postgres, per CLAUDE.md. Most of what follows is about what is IN the
// table — the order the keys sort by, the executor each row was seeded with, the
// normalization the store applies — and one case is about what is NOT: after a
// row fails, no card and no partial list survive. A mocked repository could
// state none of them.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
  vi.restoreAllMocks();
});

/** Author + approve a one-`add` plan, returning the created work item's id. */
async function approveOneAdd(
  fx: WorkItemFixture,
  proposedFields: PlanItemProposedFields,
): Promise<{ id: string }> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'add', proposedFields }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  return adminDb.workItem.findFirstOrThrow({
    where: { projectId: fx.projectId, title: proposedFields.title },
  });
}

/** The four-step `manual` card the ADR's own example describes. */
const FOUR_STEPS: PlanItemProposedFields = {
  title: 'Provision the Stripe restricted key',
  kind: 'task',
  type: 'manual',
  executor: 'human',
  todos: [
    { text: 'Create a restricted API key' },
    {
      text: 'Scope it to charges:write',
      notesMd: 'Dashboard → Developers → API keys → the key → **Edit permissions**.',
    },
    {
      text: 'Set it as the deployment secret',
      commandText: 'fly secrets set STRIPE_KEY=… -a motir',
      executor: 'coding_agent',
    },
    { text: 'Confirm a test charge succeeds' },
  ],
};

describe('materialize — a proposal’s todos become the card’s to-do rows (MOTIR-4618)', () => {
  it('writes one row per step, in ARRAY ORDER, none ticked', async () => {
    const fx = await makeWorkItemFixture();
    const created = await approveOneAdd(fx, FOUR_STEPS);

    const list = await workItemTodosService.listTodos(created.id, fx.ctx);
    expect(list.items.map((t) => t.text)).toEqual([
      'Create a restricted API key',
      'Scope it to charges:write',
      'Set it as the deployment secret',
      'Confirm a test charge succeeds',
    ]);
    expect(list.items.every((t) => t.done)).toBe(false);
    expect(list.items.every((t) => t.doneAt === null && t.doneBy === null)).toBe(true);
    expect(list.progress).toEqual({ done: 0, total: 4 });

    // The order is a PROPERTY OF THE KEYS, not of the insert order the read
    // happened to return — `listByWorkItem` sorts on `position`, so a list that
    // came back right with colliding keys would be right by luck.
    const positions = list.items.map((t) => t.position);
    expect([...positions].sort()).toEqual(positions);
    expect(new Set(positions).size).toBe(4);
  });

  it('seeds each row’s executor: the row’s own, else the proposal’s, else `human`', async () => {
    const fx = await makeWorkItemFixture();
    const created = await approveOneAdd(fx, FOUR_STEPS);

    const list = await workItemTodosService.listTodos(created.id, fx.ctx);
    // Rows 1, 2 and 4 name none and inherit the card's `human`; row 3 names
    // `coding_agent` and keeps it — the one-click exception on the odd row.
    expect(list.items.map((t) => t.executor)).toEqual(['human', 'human', 'coding_agent', 'human']);
  });

  it('falls all the way to `human` when NEITHER the row nor the proposal names one', async () => {
    const fx = await makeWorkItemFixture();
    const created = await approveOneAdd(fx, {
      title: 'An unassigned card with a step',
      kind: 'task',
      todos: [{ text: 'Do the one thing' }],
    });

    const list = await workItemTodosService.listTodos(created.id, fx.ctx);
    expect(list.items[0]!.executor).toBe('human');
  });

  it('stores notes and command NORMALIZED, through the service’s own helpers', async () => {
    const fx = await makeWorkItemFixture();
    const created = await approveOneAdd(fx, {
      title: 'A card whose steps arrived padded',
      kind: 'task',
      todos: [
        // Padded on every field, and two fields that are whitespace-only —
        // which the store normalizes to `null`, never to `''` (a row that
        // renders a copy button for nothing).
        { text: '  Run the migration  ', notesMd: '   ', commandText: '  pnpm db:migrate  ' },
        { text: 'A step with neither', notesMd: null, commandText: '   ' },
      ],
    });

    const list = await workItemTodosService.listTodos(created.id, fx.ctx);
    expect(list.items[0]).toMatchObject({
      text: 'Run the migration',
      notesMd: null,
      commandText: 'pnpm db:migrate',
    });
    expect(list.items[1]).toMatchObject({ notesMd: null, commandText: null });
  });

  it('carries every row in the created item’s `created` revision, as `todos.added`', async () => {
    const fx = await makeWorkItemFixture();
    const created = await approveOneAdd(fx, FOUR_STEPS);

    const rev = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: created.id, changeKind: 'created' },
    });
    const diff = rev.diff as {
      todos?: { added: Array<{ id: string; text: string }> };
    };
    expect(diff.todos?.added).toHaveLength(4);
    expect(diff.todos?.added.map((t) => t.text)).toEqual([
      'Create a restricted API key',
      'Scope it to charges:write',
      'Set it as the deployment secret',
      'Confirm a test charge succeeds',
    ]);
    // The ids are the REAL rows', not a re-derivation — the same shape
    // `recordTodoRevision` writes for a hand-added row.
    const rows = await workItemTodosService.listTodos(created.id, fx.ctx);
    expect(diff.todos!.added.map((t) => t.id)).toEqual(rows.items.map((t) => t.id));
  });

  it('writes NO rows and NO `todos` key for an empty list or an absent one', async () => {
    const fx = await makeWorkItemFixture();

    const cases: Array<[string, ProposedTodoInput[] | undefined]> = [
      ['An add with an empty list', []],
      ['An add with no list at all', undefined],
    ];
    for (const [title, todos] of cases) {
      const created = await approveOneAdd(fx, { title, kind: 'task', todos });
      const list = await workItemTodosService.listTodos(created.id, fx.ctx);
      expect(list.items).toEqual([]);
      expect(list.progress).toEqual({ done: 0, total: 0 });

      const rev = await adminDb.workItemRevision.findFirstOrThrow({
        where: { workItemId: created.id, changeKind: 'created' },
      });
      expect(rev.diff).not.toHaveProperty('todos');
    }
  });

  it('rolls the WHOLE approve back when a later row fails — no card with half a list', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'A card that must not survive',
            kind: 'task',
            todos: [{ text: 'The first step' }, { text: 'The step that fails' }],
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // Fail the SECOND row only — the first has already been written, so this is
    // the partial-list state and not a create that never started.
    const real = workItemTodoRepository.create;
    let calls = 0;
    const spy = vi
      .spyOn(workItemTodoRepository, 'create')
      .mockImplementation(async (data, tx) =>
        ++calls === 2 ? Promise.reject(new Error('boom')) : real(data, tx),
      );

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toThrow('boom');
    spy.mockRestore();

    // Nothing survives: not the card, not its first row, and the plan is still
    // `planned` rather than `approved`.
    expect(
      await adminDb.workItem.findFirst({ where: { title: 'A card that must not survive' } }),
    ).toBeNull();
    expect(await adminDb.workItemTodo.count()).toBe(0);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
      'planned',
    );
  });

  it('scopes every row to the plan’s own workspace', async () => {
    const fx = await makeWorkItemFixture();
    const created = await approveOneAdd(fx, FOUR_STEPS);

    const rows = await adminDb.workItemTodo.findMany({ where: { workItemId: created.id } });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([fx.ctx.workspaceId]));
  });
});
