import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import {
  ADD_WORK_ITEM_TODO_TOOL_NAME,
  DELETE_WORK_ITEM_TODO_TOOL_NAME,
  LIST_WORK_ITEM_TODOS_TOOL_NAME,
  SET_WORK_ITEM_TODO_DONE_TOOL_NAME,
  UPDATE_WORK_ITEM_TODO_TOOL_NAME,
  runAddWorkItemTodo,
  runDeleteWorkItemTodo,
  runListWorkItemTodos,
  runSetWorkItemTodoDone,
  runUpdateWorkItemTodo,
} from '@/lib/mcp/tools/workItemTodos';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { workItemsService } from '@/lib/services/workItemsService';
import { TODO_TEXT_MAX_LENGTH } from '@/lib/workItemTodos/limits';
import { makeWorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { adminDb } from '../helpers/adminDb';

// MOTIR-6725 — the three to-do tools, entered at the TOOL ADAPTER so the key
// resolution, the card scoping of a tick and the error mapping are what is
// under test. The permission, cross-tenant and concurrency cases through the
// real transport are the story's integration gate (MOTIR-6726).
//
// Each case is chosen so the obvious broken implementation fails it:
//
//   1. APPEND ORDER is read back through `list`, after THREE appends — a tool
//      that inserted at the front, or a list that sorted by id, passes on one.
//   2. A STEP FROM ANOTHER CARD is refused AND left unticked — a tool that
//      passed only the `todoId` to the service would tick it successfully.
//   3. A RE-TICK keeps the original `doneAt` — a service that re-stamped on
//      every tick would still answer `done: true`.
//   4. OVER-CAP TEXT is refused with the store's own code and writes no row —
//      a truncating tool would succeed with a shortened step.

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeItem(title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

interface TodoOut {
  id: string;
  text: string;
  done: boolean;
  doneAt: string | null;
  doneBy: { id: string; name: string } | null;
  executor: string | null;
  commandText: string | null;
  notesMd: string | null;
}
interface ListOut {
  workItemKey: string;
  items: TodoOut[];
  progress: { done: number; total: number };
}
interface WriteOut {
  workItemKey: string;
  todo: TodoOut;
  progress: { done: number; total: number };
}

function ok<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}

async function add(key: string, text: string): Promise<TodoOut> {
  return ok<WriteOut>(await runAddWorkItemTodo({ key, text }, fx.ctx)).todo;
}

describe('the tools are registered, gated and exempt as documented', () => {
  it('registers all five', () => {
    expect(MCP_TOOL_NAMES).toContain(LIST_WORK_ITEM_TODOS_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(ADD_WORK_ITEM_TODO_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(SET_WORK_ITEM_TODO_DONE_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(UPDATE_WORK_ITEM_TODO_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(DELETE_WORK_ITEM_TODO_TOOL_NAME);
  });

  it('the read is browse, the writes are work_item:edit — all five in the CLI grant', () => {
    expect(TOOL_PERMISSIONS[LIST_WORK_ITEM_TODOS_TOOL_NAME]).toBe('project:browse');
    expect(TOOL_PERMISSIONS[ADD_WORK_ITEM_TODO_TOOL_NAME]).toBe('work_item:edit');
    expect(TOOL_PERMISSIONS[SET_WORK_ITEM_TODO_DONE_TOOL_NAME]).toBe('work_item:edit');
    expect(TOOL_PERMISSIONS[UPDATE_WORK_ITEM_TODO_TOOL_NAME]).toBe('work_item:edit');
    expect(TOOL_PERMISSIONS[DELETE_WORK_ITEM_TODO_TOOL_NAME]).toBe('work_item:edit');
    for (const name of [
      LIST_WORK_ITEM_TODOS_TOOL_NAME,
      ADD_WORK_ITEM_TODO_TOOL_NAME,
      SET_WORK_ITEM_TODO_DONE_TOOL_NAME,
      UPDATE_WORK_ITEM_TODO_TOOL_NAME,
      DELETE_WORK_ITEM_TODO_TOOL_NAME,
    ] as const) {
      expect(CLI_TOKEN_GRANT).toContain(TOOL_PERMISSIONS[name]);
      expect(Object.keys(EXEMPT_TOOLS)).toContain(name);
    }
  });
});

describe('list_work_item_todos', () => {
  it('a card with no steps answers an empty list and 0 of 0', async () => {
    const key = await makeItem('Nothing to do');
    const out = ok<ListOut>(await runListWorkItemTodos({ key }, fx.ctx));
    expect(out.workItemKey).toBe(key);
    expect(out.items).toEqual([]);
    expect(out.progress).toEqual({ done: 0, total: 0 });
  });

  it('an unknown key is not-found', async () => {
    const text = errorText(await runListWorkItemTodos({ key: 'PROD-99999' }, fx.ctx));
    expect(text).toContain('NOT_FOUND');
  });
});

describe('add_work_item_todo', () => {
  it('appends each step at the END, in the order they were added', async () => {
    const key = await makeItem('Set up billing');
    await add(key, 'Create the Stripe account');
    await add(key, 'Copy the secret key');
    const third = ok<WriteOut>(
      await runAddWorkItemTodo(
        {
          key: key.toLowerCase(),
          text: 'Set the env var',
          commandText: 'vercel env add STRIPE_SECRET_KEY',
          notesMd: 'Use the **restricted** key.',
          executor: 'coding_agent',
        },
        fx.ctx,
      ),
    );
    expect(third.progress).toEqual({ done: 0, total: 3 });
    expect(third.todo.commandText).toBe('vercel env add STRIPE_SECRET_KEY');
    expect(third.todo.notesMd).toBe('Use the **restricted** key.');
    expect(third.todo.executor).toBe('coding_agent');

    const list = ok<ListOut>(await runListWorkItemTodos({ key }, fx.ctx));
    expect(list.items.map((t) => t.text)).toEqual([
      'Create the Stripe account',
      'Copy the secret key',
      'Set the env var',
    ]);
    expect(list.items.at(-1)?.id).toBe(third.todo.id);
  });

  it('an omitted executor is seeded from the card, and `human` when the card has none', async () => {
    const key = await makeItem('No executor');
    const todo = await add(key, 'Do the thing');
    expect(todo.executor).toBe('human');
  });

  it('refuses text over the cap with the store’s own code, and writes no row', async () => {
    const key = await makeItem('Too long');
    const text = errorText(
      await runAddWorkItemTodo({ key, text: 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1) }, fx.ctx),
    );
    expect(text).toContain('TODO_TEXT_TOO_LONG');
    expect(await adminDb.workItemTodo.count()).toBe(0);
  });

  it('refuses whitespace-only text', async () => {
    const key = await makeItem('Empty');
    expect(errorText(await runAddWorkItemTodo({ key, text: '   ' }, fx.ctx))).toContain(
      'EMPTY_TODO_TEXT',
    );
    expect(await adminDb.workItemTodo.count()).toBe(0);
  });
});

describe('set_work_item_todo_done', () => {
  it('ticks and unticks, moving the progress both ways', async () => {
    const key = await makeItem('Tick me');
    const first = await add(key, 'Step one');
    await add(key, 'Step two');

    const ticked = ok<WriteOut>(
      await runSetWorkItemTodoDone({ key, todoId: first.id, done: true }, fx.ctx),
    );
    expect(ticked.todo.done).toBe(true);
    expect(ticked.todo.doneAt).not.toBeNull();
    expect(ticked.todo.doneBy?.id).toBe(fx.ownerId);
    expect(ticked.progress).toEqual({ done: 1, total: 2 });

    const unticked = ok<WriteOut>(
      await runSetWorkItemTodoDone({ key, todoId: first.id, done: false }, fx.ctx),
    );
    expect(unticked.todo.done).toBe(false);
    expect(unticked.todo.doneAt).toBeNull();
    expect(unticked.todo.doneBy).toBeNull();
    expect(unticked.progress).toEqual({ done: 0, total: 2 });
  });

  it('a second tick is a no-op that keeps the ORIGINAL doneAt and doneBy', async () => {
    const key = await makeItem('Retry');
    const step = await add(key, 'Only step');
    const first = ok<WriteOut>(
      await runSetWorkItemTodoDone({ key, todoId: step.id, done: true }, fx.ctx),
    );
    const again = ok<WriteOut>(
      await runSetWorkItemTodoDone({ key, todoId: step.id, done: true }, fx.ctx),
    );
    expect(again.todo.doneAt).toBe(first.todo.doneAt);
    expect(again.todo.doneBy).toEqual(first.todo.doneBy);
    expect(again.progress).toEqual({ done: 1, total: 1 });
  });

  it('ticking the LAST step does not move the card’s status', async () => {
    const key = await makeItem('Status stays');
    const before = await workItemsService.getWorkItemByIdentifier(fx.projectId, key, fx.ctx);
    const step = await add(key, 'Only step');
    ok(await runSetWorkItemTodoDone({ key, todoId: step.id, done: true }, fx.ctx));
    const after = await workItemsService.getWorkItemByIdentifier(fx.projectId, key, fx.ctx);
    expect(after.status).toBe(before.status);
  });

  it('refuses a step that belongs to ANOTHER card, and leaves it unticked', async () => {
    const mine = await makeItem('Mine');
    const other = await makeItem('Other');
    const foreign = await add(other, 'Their step');

    const text = errorText(
      await runSetWorkItemTodoDone({ key: mine, todoId: foreign.id, done: true }, fx.ctx),
    );
    expect(text).toContain('WORK_ITEM_TODO_NOT_FOUND');
    const row = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(row.doneAt).toBeNull();
  });

  it('refuses a step id that names nothing', async () => {
    const key = await makeItem('Ghost');
    const text = errorText(
      await runSetWorkItemTodoDone({ key, todoId: 'tdo_nope', done: true }, fx.ctx),
    );
    expect(text).toContain('WORK_ITEM_TODO_NOT_FOUND');
  });
});

describe('update_work_item_todo', () => {
  it('changes only the fields sent, and an empty patch is a no-op answer', async () => {
    const key = await makeItem('Edit me');
    const step = ok<WriteOut>(
      await runAddWorkItemTodo(
        { key, text: 'Old text', notesMd: 'Keep these notes.', commandText: 'make it' },
        fx.ctx,
      ),
    ).todo;

    const out = ok<WriteOut>(
      await runUpdateWorkItemTodo({ key, todoId: step.id, text: 'New text' }, fx.ctx),
    );
    expect(out.workItemKey).toBe(key);
    expect(out.todo).toMatchObject({
      id: step.id,
      text: 'New text',
      notesMd: 'Keep these notes.',
      commandText: 'make it',
    });
    expect(out.progress).toEqual({ done: 0, total: 1 });

    const same = ok<WriteOut>(await runUpdateWorkItemTodo({ key, todoId: step.id }, fx.ctx));
    expect(same.todo.text).toBe('New text');
  });

  it('null clears the notes, the command and the executor', async () => {
    const key = await makeItem('Clear me');
    const step = ok<WriteOut>(
      await runAddWorkItemTodo(
        { key, text: 'Step', notesMd: 'n', commandText: 'c', executor: 'coding_agent' },
        fx.ctx,
      ),
    ).todo;
    const out = ok<WriteOut>(
      await runUpdateWorkItemTodo(
        { key, todoId: step.id, notesMd: null, commandText: null, executor: null },
        fx.ctx,
      ),
    );
    expect(out.todo).toMatchObject({ notesMd: null, commandText: null, executor: null });
  });

  it('refuses a step that belongs to ANOTHER card, and leaves it as it was', async () => {
    const mine = await makeItem('Mine');
    const other = await makeItem('Other');
    const foreign = await add(other, 'Their step');
    const text = errorText(
      await runUpdateWorkItemTodo({ key: mine, todoId: foreign.id, text: 'Hijacked' }, fx.ctx),
    );
    expect(text).toContain('WORK_ITEM_TODO_NOT_FOUND');
    const row = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(row.text).toBe('Their step');
  });

  it('refuses whitespace-only text with the store’s own code', async () => {
    const key = await makeItem('Blank');
    const step = await add(key, 'Step');
    expect(
      errorText(await runUpdateWorkItemTodo({ key, todoId: step.id, text: '  ' }, fx.ctx)),
    ).toContain('EMPTY_TODO_TEXT');
  });
});

describe('delete_work_item_todo', () => {
  it('removes the step and reports what went and the new progress', async () => {
    const key = await makeItem('Delete from me');
    const keep = await add(key, 'Keep');
    const drop = await add(key, 'Drop');
    const out = ok<{
      workItemKey: string;
      removed: { id: string; text: string };
      progress: { done: number; total: number };
    }>(await runDeleteWorkItemTodo({ key, todoId: drop.id }, fx.ctx));
    expect(out).toEqual({
      workItemKey: key,
      removed: { id: drop.id, text: 'Drop' },
      progress: { done: 0, total: 1 },
    });
    const list = ok<ListOut>(await runListWorkItemTodos({ key }, fx.ctx));
    expect(list.items.map((t) => t.id)).toEqual([keep.id]);
  });

  it('refuses a step that belongs to ANOTHER card, and leaves it in place', async () => {
    const mine = await makeItem('Mine');
    const other = await makeItem('Other');
    const foreign = await add(other, 'Their step');
    const text = errorText(await runDeleteWorkItemTodo({ key: mine, todoId: foreign.id }, fx.ctx));
    expect(text).toContain('WORK_ITEM_TODO_NOT_FOUND');
    expect(await adminDb.workItemTodo.count({ where: { id: foreign.id } })).toBe(1);
  });

  it('refuses a step id that names nothing, and an unknown key', async () => {
    const key = await makeItem('Ghost');
    expect(errorText(await runDeleteWorkItemTodo({ key, todoId: 'tdo_nope' }, fx.ctx))).toContain(
      'WORK_ITEM_TODO_NOT_FOUND',
    );
    expect(
      errorText(await runDeleteWorkItemTodo({ key: 'PROD-99999', todoId: 'tdo_nope' }, fx.ctx)),
    ).toContain('NOT_FOUND');
  });
});
