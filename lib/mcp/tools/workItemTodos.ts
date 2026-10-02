import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { TodoProgressDto, WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import { WorkItemTodoNotFoundError } from '@/lib/workItemTodos/errors';
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// The to-do tools (Story MOTIR-6739 · MOTIR-6725) — the MCP door onto a
// COMMITTED card's to-do list (Story MOTIR-3808,
// `docs/decisions/work-item-todo-list.md`). Until these, the MCP carried to-dos
// only on plan PROPOSALS (`authorPlan.ts`, `getPlan.ts`), so an agent could not
// see where a manual card had got to, or record a step as done.
//
// Thin adapters over the shipped `workItemTodosService`: the card is resolved
// by key the way every key-addressed tool resolves it (the 404-not-403
// contract), and every rule — the browse gate on the read, the
// `work_item:edit` gate on every write, the caps, the append-at-the-end lock,
// the no-revision tick, the revision an edit or a delete records — is the
// service's, unchanged. No business logic here.
//
// EDIT and DELETE joined the first three in MOTIR-7306: a card whose steps
// change after they were written (a re-plan removes one, a step turns out to
// be wrong) otherwise left an agent two bad choices — leave a step the card can
// never close on, or tick one nobody performed. REORDER is still not exposed;
// nothing asks for it.
//
// ⚠️ AND TICKING THE LAST STEP DOES NOT MOVE THE CARD (ADR §3). The service
// never touches `work_item.status`, and neither does this door.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): no `/api/v1`
// operation returns a committed card's to-do list — the item page reads it
// through its own Server Actions — so there is no shared shape to derive from.

export const LIST_WORK_ITEM_TODOS_TOOL_NAME = 'list_work_item_todos';
export const ADD_WORK_ITEM_TODO_TOOL_NAME = 'add_work_item_todo';
export const SET_WORK_ITEM_TODO_DONE_TOOL_NAME = 'set_work_item_todo_done';
export const UPDATE_WORK_ITEM_TODO_TOOL_NAME = 'update_work_item_todo';
export const DELETE_WORK_ITEM_TODO_TOOL_NAME = 'delete_work_item_todo';

const executorField = z
  .enum(['coding_agent', 'human'])
  .optional()
  .describe(
    'Who this step is for: "human" or "coding_agent". Declarative — it authorizes nothing. ' +
      'Omitted ⇒ the card’s own executor, or "human" when the card has none.',
  );

const listInputSchema = {
  key: workItemKeyField,
};

const addInputSchema = {
  key: workItemKeyField,
  text: z
    .string()
    .min(1)
    .describe(
      `The step — ONE operation, in plain text (not Markdown), at most ${TODO_TEXT_MAX_LENGTH} ` +
        'characters. A longer step is two steps, and is refused rather than truncated.',
    ),
  notesMd: z
    .string()
    .optional()
    .describe(
      `Optional instructions for this one step, in Markdown, at most ${TODO_NOTES_MAX_LENGTH} ` +
        'characters — the how, where `text` is the what.',
    ),
  commandText: z
    .string()
    .optional()
    .describe(
      `Optional command this step runs, at most ${TODO_COMMAND_MAX_LENGTH} characters. ` +
        'Rendered with a copy button on the work item page.',
    ),
  executor: executorField,
};

const todoIdField = z
  .string()
  .min(1)
  .describe(
    'The step’s id, as `list_work_item_todos` or `add_work_item_todo` returned it. A step on ' +
      'another work item is refused as not found.',
  );

const setDoneInputSchema = {
  key: workItemKeyField,
  todoId: todoIdField,
  done: z.boolean().describe('true ticks the step; false unticks it.'),
};

const updateInputSchema = {
  key: workItemKeyField,
  todoId: todoIdField,
  text: z
    .string()
    .min(1)
    .optional()
    .describe(
      `The step’s new text — ONE operation, in plain text, at most ${TODO_TEXT_MAX_LENGTH} ` +
        'characters. Omitted ⇒ unchanged.',
    ),
  notesMd: z
    .string()
    .nullable()
    .optional()
    .describe(
      `New instructions for the step, in Markdown, at most ${TODO_NOTES_MAX_LENGTH} characters. ` +
        'Omitted ⇒ unchanged; null clears them.',
    ),
  commandText: z
    .string()
    .nullable()
    .optional()
    .describe(
      `New command for the step, at most ${TODO_COMMAND_MAX_LENGTH} characters. Omitted ⇒ ` +
        'unchanged; null clears it.',
    ),
  executor: z
    .enum(['coding_agent', 'human'])
    .nullable()
    .optional()
    .describe(
      'Who the step is for: "human" or "coding_agent". Omitted ⇒ unchanged; null clears it.',
    ),
};

const deleteInputSchema = {
  key: workItemKeyField,
  todoId: todoIdField,
};

/** One step as the tool returns it — the service DTO's fields, named explicitly. */
function presentTodo(todo: WorkItemTodoDto): Record<string, unknown> {
  return {
    id: todo.id,
    position: todo.position,
    text: todo.text,
    notesMd: todo.notesMd,
    commandText: todo.commandText,
    executor: todo.executor,
    done: todo.done,
    doneAt: todo.doneAt,
    doneBy: todo.doneBy,
  };
}

/** `2 of 5 done` — the header the work item page renders. */
function progressLine(progress: TodoProgressDto): string {
  return `${progress.done} of ${progress.total} done`;
}

/** One step as a compact line: `[x] 1. text (id)`. */
function todoLine(todo: WorkItemTodoDto, index: number): string {
  const command = todo.commandText ? ` · command: ${todo.commandText}` : '';
  const executor = todo.executor ? ` · ${todo.executor}` : '';
  return `[${todo.done ? 'x' : ' '}] ${index + 1}. ${todo.text}${executor}${command} (${todo.id})`;
}

/** `list_work_item_todos` — the card's steps in list order, with its progress. */
export async function runListWorkItemTodos(
  args: { key: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    const list = await workItemTodosService.listTodos(item.id, ctx);
    const header = `${item.identifier} to-do list — ${progressLine(list.progress)}`;
    const lines = list.items.length === 0 ? ['(no steps)'] : list.items.map(todoLine);
    return toolOk(
      [header, ...lines].join('\n'),
      exempt(LIST_WORK_ITEM_TODOS_TOOL_NAME, {
        workItemKey: item.identifier,
        items: list.items.map(presentTodo),
        progress: list.progress,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** `add_work_item_todo` — append one step at the end of the card's list. */
export async function runAddWorkItemTodo(
  args: {
    key: string;
    text: string;
    notesMd?: string;
    commandText?: string;
    executor?: 'coding_agent' | 'human';
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    const { todo, progress } = await workItemTodosService.addTodo(
      item.id,
      {
        text: args.text,
        notesMd: args.notesMd,
        commandText: args.commandText,
        executor: args.executor,
      },
      ctx,
    );
    return toolOk(
      `Added a step to ${item.identifier}: ${todo.text} (${todo.id}) — ${progressLine(progress)}`,
      exempt(ADD_WORK_ITEM_TODO_TOOL_NAME, {
        workItemKey: item.identifier,
        todo: presentTodo(todo),
        progress,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** `set_work_item_todo_done` — tick or untick one step of THIS card. */
export async function runSetWorkItemTodoDone(
  args: { key: string; todoId: string; done: boolean },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    const { todo, progress } = await workItemTodosService.setTodoDone(args.todoId, args.done, ctx, {
      workItemId: item.id,
    });
    return toolOk(
      `${todo.done ? 'Ticked' : 'Unticked'} a step on ${item.identifier}: ${todo.text} — ` +
        progressLine(progress),
      exempt(SET_WORK_ITEM_TODO_DONE_TOOL_NAME, {
        workItemKey: item.identifier,
        todo: presentTodo(todo),
        progress,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/**
 * The step `todoId` names, read from `workItemId`'s OWN list — so a step of
 * another card is not found, exactly as `set_work_item_todo_done` refuses it,
 * and is refused before the edit gate can confirm it exists. A step never moves
 * between cards (no service write touches `workItemId`), so this read cannot go
 * stale on the one fact it checks; a step deleted in between is not found by
 * the write itself.
 */
async function findTodoOnWorkItem(
  workItemId: string,
  todoId: string,
  ctx: ServiceContext,
): Promise<WorkItemTodoDto> {
  const list = await workItemTodosService.listTodos(workItemId, ctx);
  const todo = list.items.find((row) => row.id === todoId);
  if (!todo) throw new WorkItemTodoNotFoundError(todoId);
  return todo;
}

/** `update_work_item_todo` — edit one step of THIS card, sparsely. */
export async function runUpdateWorkItemTodo(
  args: {
    key: string;
    todoId: string;
    text?: string;
    notesMd?: string | null;
    commandText?: string | null;
    executor?: 'coding_agent' | 'human' | null;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    await findTodoOnWorkItem(item.id, args.todoId, ctx);
    const { todo, progress } = await workItemTodosService.updateTodo(
      args.todoId,
      {
        text: args.text,
        notesMd: args.notesMd,
        commandText: args.commandText,
        executor: args.executor,
      },
      ctx,
    );
    return toolOk(
      `Updated a step on ${item.identifier}: ${todo.text} (${todo.id}) — ${progressLine(progress)}`,
      exempt(UPDATE_WORK_ITEM_TODO_TOOL_NAME, {
        workItemKey: item.identifier,
        todo: presentTodo(todo),
        progress,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** `delete_work_item_todo` — remove one step of THIS card. */
export async function runDeleteWorkItemTodo(
  args: { key: string; todoId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    const removed = await findTodoOnWorkItem(item.id, args.todoId, ctx);
    const progress = await workItemTodosService.deleteTodo(args.todoId, ctx);
    return toolOk(
      `Deleted a step from ${item.identifier}: ${removed.text} — ${progressLine(progress)}`,
      exempt(DELETE_WORK_ITEM_TODO_TOOL_NAME, {
        workItemKey: item.identifier,
        removed: { id: removed.id, text: removed.text },
        progress,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerWorkItemTodos(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LIST_WORK_ITEM_TODOS_TOOL_NAME,
    {
      title: 'List a work item’s to-do list',
      description:
        'Read a work item’s TO-DO LIST (by identifier, e.g. "ACME-7"): its steps in list order — ' +
        'each with its `id`, `text`, optional `notesMd` instructions and `commandText`, who it is ' +
        'for (`executor`), and whether it is `done` — plus the progress (`done` of `total`). A ' +
        'work item with no steps answers an empty list and 0 of 0. Honors the same access checks ' +
        'as the UI.',
      inputSchema: listInputSchema,
    },
    async (args, extra) => runListWorkItemTodos(args, resolveContext(extra)),
  );
  server.registerTool(
    ADD_WORK_ITEM_TODO_TOOL_NAME,
    {
      title: 'Add a to-do step',
      description:
        'Append ONE step to the END of a work item’s to-do list (by identifier, e.g. "ACME-7"). ' +
        'A step is one operation: `text` over the cap is refused, never truncated. Returns the ' +
        'new step (with its `id`) and the list’s progress. Needs permission to edit the work ' +
        'item. Honors the same access checks as the UI.',
      inputSchema: addInputSchema,
    },
    async (args, extra) => runAddWorkItemTodo(args, resolveContext(extra)),
  );
  server.registerTool(
    SET_WORK_ITEM_TODO_DONE_TOOL_NAME,
    {
      title: 'Tick or untick a to-do step',
      description:
        'Tick (`done: true`) or untick (`done: false`) one step of a work item’s to-do list, by ' +
        'the work item’s identifier and the step’s `todoId`. A `todoId` that is not on that work ' +
        'item is refused as not found. Ticking is idempotent, and ticking the LAST step does not ' +
        'change the work item’s status. Returns the step and the list’s progress. Needs ' +
        'permission to edit the work item. Honors the same access checks as the UI.',
      inputSchema: setDoneInputSchema,
    },
    async (args, extra) => runSetWorkItemTodoDone(args, resolveContext(extra)),
  );
  server.registerTool(
    UPDATE_WORK_ITEM_TODO_TOOL_NAME,
    {
      title: 'Edit a to-do step',
      description:
        'Edit one step of a work item’s to-do list, by the work item’s identifier and the ' +
        'step’s `todoId`. SPARSE: only the fields you send change — an omitted field is left ' +
        'alone, and `null` clears `notesMd`, `commandText` or `executor`. A `todoId` that is not ' +
        'on that work item is refused as not found. Records a revision on the work item. ' +
        'Returns the step as it now stands and the list’s progress. Needs permission to edit ' +
        'the work item. Honors the same access checks as the UI.',
      inputSchema: updateInputSchema,
    },
    async (args, extra) => runUpdateWorkItemTodo(args, resolveContext(extra)),
  );
  server.registerTool(
    DELETE_WORK_ITEM_TODO_TOOL_NAME,
    {
      title: 'Delete a to-do step',
      description:
        'Permanently delete one step of a work item’s to-do list, by the work item’s identifier ' +
        'and the step’s `todoId`. A `todoId` that is not on that work item is refused as not ' +
        'found. Records a revision on the work item. Returns what was removed and the list’s ' +
        'new progress. Needs permission to edit the work item. Honors the same access checks ' +
        'as the UI.',
      inputSchema: deleteInputSchema,
    },
    async (args, extra) => runDeleteWorkItemTodo(args, resolveContext(extra)),
  );
}
