import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemTodoRepository } from '@/lib/repositories/workItemTodoRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { toWorkItemTodoListDto } from '@/lib/mappers/workItemTodoMappers';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';

// The STORY GATE for the to-do list (Story MOTIR-3808 · MOTIR-3816) — the seams
// BETWEEN the three code siblings, which each sibling's own unit tests mock
// away, plus the guards a coverage percentage cannot see.
//
// The coverage floor half of this card is `vitest.config.ts`: the eight files
// are in `coverage.include` and each is pinned at 90 in `thresholds` (the two
// under `app/` entered as `app/**`, because `(authed)` is grouping syntax to
// picomatch and a literal path would gate nothing — MOTIR-2449).
//
// ⚠️ EVERY BEHAVIOUR BELOW MAPS TO A SYMBOL ITS SIBLINGS SHIPPED, per the
// card's criterion 6:
//   listTodos / addTodo / updateTodo / moveTodo / setTodoDone / deleteTodo
//     → lib/services/workItemTodosService.ts
//   toWorkItemTodoListDto                → lib/mappers/workItemTodoMappers.ts
//   WorkItemTodoDto / WorkItemTodoListDto → lib/dto/workItemTodos.ts
//   listByWorkItem / countByWorkItem      → lib/repositories/workItemTodoRepository.ts
// Nothing here anticipates MOTIR-3809's dispatch or MOTIR-1344's assistant.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_todo", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "workspace_membership", "workspace", "session", "account", "verification", "user" RESTART IDENTITY CASCADE',
  );
}

beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeCard(fx: WorkItemFixture, title = 'Cut the release'): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

// ── §2 — the seams, against real Postgres and the real service ──────────────

describe('seam: service → mapper → DTO', () => {
  it('every field the section reads is satisfiable from ONE real payload', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemTodosService.addTodo(card, { text: 'Plain step' }, fx.ctx);
    await workItemTodosService.addTodo(
      card,
      { text: 'Command step', commandText: 'pnpm build', executor: 'coding_agent' },
      fx.ctx,
    );
    const third = await workItemTodosService.addTodo(card, { text: 'Ticked' }, fx.ctx);
    await workItemTodosService.setTodoDone(third.todo.id, true, fx.ctx);

    const list = await workItemTodosService.listTodos(card, fx.ctx);

    for (const row of list.items) {
      // `commandText` is a string or null — NEVER '' (the client tests this
      // field to decide whether to draw the copy affordance at all).
      expect(row.commandText === null || typeof row.commandText === 'string').toBe(true);
      expect(row.commandText).not.toBe('');
      // `notesMd` carries the same contract.
      expect(row.notesMd === null || typeof row.notesMd === 'string').toBe(true);
      expect(row.notesMd).not.toBe('');
      // `executor` is one of the enum's two values, or null.
      expect([null, 'human', 'coding_agent']).toContain(row.executor);
      // `done` is DERIVED from doneAt and cannot disagree with it.
      expect(row.done).toBe(row.doneAt !== null);
    }

    // The envelope's own counts agree with the rows it ships beside them.
    expect(list.progress.total).toBe(list.items.length);
    expect(list.progress.done).toBe(list.items.filter((r) => r.done).length);
  });

  it('the MAPPER produces the same envelope the service does, from the same rows', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemTodosService.addTodo(card, { text: 'A', commandText: 'pnpm a' }, fx.ctx);
    await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);

    const viaService = await workItemTodosService.listTodos(card, fx.ctx);
    const rows = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemTodoRepository.listByWorkItem(card, tx),
    );
    // Drives the real mapper over the real rows — the layer the section's own
    // tests stub, and the one place a field could be dropped silently.
    expect(toWorkItemTodoListDto(rows)).toEqual(viaService);
  });
});

describe('seam: write → read-back', () => {
  it('every action’s returned envelope equals an INDEPENDENT read taken straight after', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const readBack = async () => (await workItemTodosService.listTodos(card, fx.ctx)).progress;

    const a = await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    expect(a.progress).toEqual(await readBack());

    const b = await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);
    expect(b.progress).toEqual(await readBack());

    const ticked = await workItemTodosService.setTodoDone(a.todo.id, true, fx.ctx);
    expect(ticked.progress).toEqual(await readBack());

    const edited = await workItemTodosService.updateTodo(b.todo.id, { text: 'B2' }, fx.ctx);
    expect(edited.progress).toEqual(await readBack());

    const moved = await workItemTodosService.moveTodo(b.todo.id, 0, fx.ctx);
    expect(moved.progress).toEqual(await readBack());

    // …and the delete's, which returns the progress bare rather than in an envelope.
    const afterDelete = await workItemTodosService.deleteTodo(b.todo.id, fx.ctx);
    expect(afterDelete).toEqual(await readBack());
  });
});

describe('seam: position ordering across a REAL reorder', () => {
  it('five in, the last moved to second — the order is what the move asked for and ONE row moved', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    for (const text of ['A', 'B', 'C', 'D', 'E']) {
      await workItemTodosService.addTodo(card, { text }, fx.ctx);
    }
    const before = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemTodoRepository.listByWorkItem(card, tx),
    );
    const positionsBefore = new Map(before.map((r) => [r.id, r.position]));
    const last = before[4]!;

    await workItemTodosService.moveTodo(last.id, 1, fx.ctx);

    const after = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemTodoRepository.listByWorkItem(card, tx),
    );
    expect(after.map((r) => r.text)).toEqual(['A', 'E', 'B', 'C', 'D']);
    // Counted, not inferred from the order: an integer rank would have rewritten
    // every row below the destination.
    const moved = after.filter((r) => positionsBefore.get(r.id) !== r.position);
    expect(moved.map((r) => r.text)).toEqual(['E']);
  });
});

// ── §3 — the guards a coverage percentage cannot see ────────────────────────

describe('guard: the import boundary', () => {
  it('only the REPOSITORY reaches Prisma — asserted by scanning the story’s files', () => {
    const repositoryFile = 'lib/repositories/workItemTodoRepository.ts';
    const others = [
      'lib/services/workItemTodosService.ts',
      'lib/dto/workItemTodos.ts',
      'lib/mappers/workItemTodoMappers.ts',
      'lib/workItemTodos/limits.ts',
      'lib/workItemTodos/errors.ts',
      'app/(authed)/items/[key]/todoActions.ts',
      'app/(authed)/items/[key]/_components/TodoListSection.tsx',
    ];

    // The repository is the ONE leaf that may import the client…
    expect(readFileSync(repositoryFile, 'utf8')).toMatch(/from '@\/generated\/prisma\/client'/);

    // …and nothing else this story added may. The service takes `Prisma` only as
    // a TYPE for the transaction client, which is a type-only import and not a
    // data-access path — so the assertion is on the VALUE import.
    for (const file of others) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not import the Prisma client as a value`).not.toMatch(
        /^import \{[^}]*\} from '@\/generated\/prisma\/client';$/m,
      );
      expect(src, `${file} must not import the db singleton`).not.toMatch(/from '@\/lib\/db'/);
    }
  });
});

describe('guard: cross-tenant isolation', () => {
  it('a row written under A is invisible to B, and a write bound to B cannot reach A’s row', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const cardA = await makeCard(a, 'A’s card');
    const cardB = await makeCard(b, 'B’s card');

    await workItemTodosService.addTodo(cardA, { text: 'A secret step' }, a.ctx);
    await workItemTodosService.addTodo(cardB, { text: 'B’s own step' }, b.ctx);
    const { todo: aRow } = await workItemTodosService.addTodo(cardA, { text: 'A second' }, a.ctx);

    // ⚠️ THE ACTOR'S VIEW AND THE TRUE POPULATION DIFFER, and that is the point
    // of the fixture: the table holds THREE rows, B may see exactly ONE, and A
    // may see exactly TWO. An actor who happened to see everything could not
    // tell a scoped read from an unscoped one, and the test would pass against
    // a policy that does nothing.
    const trueTotal = await adminDb.workItemTodo.count();
    expect(trueTotal).toBe(3);

    const seenByB = await withWorkspaceContext(b.ctx, (tx) =>
      workItemTodoRepository.listByWorkItem(cardA, tx),
    );
    expect(seenByB).toEqual([]);

    const bsOwn = await workItemTodosService.listTodos(cardB, b.ctx);
    expect(bsOwn.items.map((r) => r.text)).toEqual(['B’s own step']);

    // A WRITE bound to B cannot reach A's row either — the read half alone
    // would pass against a policy with a USING clause and no WITH CHECK.
    await expect(
      workItemTodosService.updateTodo(aRow.id, { text: 'stolen' }, b.ctx),
    ).rejects.toThrow();
    const stillA = await workItemTodosService.listTodos(cardA, a.ctx);
    expect(stillA.items.map((r) => r.text)).toEqual(['A secret step', 'A second']);
  });
});

describe('guard: revision totality', () => {
  it('add / edit / move / delete each record one, and a TICK records NONE', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const count = async () => {
      const rows = await withWorkspaceContext(fx.ctx, (tx) =>
        workItemRevisionRepository.listByWorkItem(card, {}, tx),
      );
      return rows.filter((r) => r.changeKind === 'updated').length;
    };

    const { todo } = await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    expect(await count()).toBe(1);

    await workItemTodosService.updateTodo(todo.id, { text: 'A2' }, fx.ctx);
    expect(await count()).toBe(2);

    await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);
    await workItemTodosService.moveTodo(todo.id, 1, fx.ctx);
    expect(await count()).toBe(4);

    // ⚠️ THE NEGATIVE ARM IS THE ONE THAT MATTERS. Only it catches a later
    // refactor that starts logging ticks, which would bury the edit that
    // mattered under six progress entries on a six-step list.
    const before = await count();
    await workItemTodosService.setTodoDone(todo.id, true, fx.ctx);
    await workItemTodosService.setTodoDone(todo.id, false, fx.ctx);
    await workItemTodosService.setTodoDone(todo.id, true, fx.ctx);
    expect(await count()).toBe(before);

    await workItemTodosService.deleteTodo(todo.id, fx.ctx);
    expect(await count()).toBe(before + 1);
  });
});

describe('guard: enum totality over Executor PLUS null', () => {
  it('all THREE cases round-trip — human, coding_agent, and none', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const human = await workItemTodosService.addTodo(
      card,
      { text: 'Mine', executor: 'human' },
      fx.ctx,
    );
    const agent = await workItemTodosService.addTodo(
      card,
      { text: 'Theirs', executor: 'coding_agent' },
      fx.ctx,
    );
    // The third case is the one a two-branch renderer drops: `executor: null`
    // is legal on the column and reachable through an explicit clear.
    const none = await workItemTodosService.addTodo(
      card,
      { text: 'Undecided', executor: null },
      fx.ctx,
    );

    expect([human.todo.executor, agent.todo.executor, none.todo.executor]).toEqual([
      'human',
      'coding_agent',
      null,
    ]);

    const list = await workItemTodosService.listTodos(card, fx.ctx);
    expect(new Set(list.items.map((r) => r.executor))).toEqual(
      new Set(['human', 'coding_agent', null]),
    );
  });
});

describe('guard: the ADR’s status refusal, at the service tier', () => {
  it('ticking every to-do leaves the work item’s status exactly where it was', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const a = await workItemTodosService.addTodo(card, { text: 'A' }, fx.ctx);
    const b = await workItemTodosService.addTodo(card, { text: 'B' }, fx.ctx);

    const statusOf = async () =>
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card } })).status;
    const before = await statusOf();

    await workItemTodosService.setTodoDone(a.todo.id, true, fx.ctx);
    const last = await workItemTodosService.setTodoDone(b.todo.id, true, fx.ctx);

    expect(last.progress).toEqual({ done: 2, total: 2 });
    // `docs/decisions/work-item-todo-list.md` §3 — a checklist is not a third
    // authority over this column.
    expect(await statusOf()).toBe(before);
  });
});

describe('guard: the permission is ONE key, at the service tier', () => {
  it('a viewer is refused all five writes and still gets the read', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const { todo } = await workItemTodosService.addTodo(card, { text: 'A step' }, fx.ctx);

    const viewer = await createTestUser({ email: 'gate-viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await withWorkspaceContext(fx.ctx, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
        tx,
      ),
    );
    const viewerCtx = { userId: viewer.id, workspaceId: fx.workspaceId };

    for (const attempt of [
      () => workItemTodosService.addTodo(card, { text: 'x' }, viewerCtx),
      () => workItemTodosService.updateTodo(todo.id, { text: 'x' }, viewerCtx),
      () => workItemTodosService.moveTodo(todo.id, 0, viewerCtx),
      () => workItemTodosService.setTodoDone(todo.id, true, viewerCtx),
      () => workItemTodosService.deleteTodo(todo.id, viewerCtx),
    ]) {
      await expect(attempt()).rejects.toThrow();
    }
    // The READ is not gated on edit — a viewer keeps the information.
    expect((await workItemTodosService.listTodos(card, viewerCtx)).items).toHaveLength(1);
  });
});
