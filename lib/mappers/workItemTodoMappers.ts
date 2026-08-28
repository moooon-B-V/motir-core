import type { WorkItemTodo } from '@/generated/prisma/client';
import type { WorkItemTodoDto, WorkItemTodoListDto } from '@/lib/dto/workItemTodos';

/**
 * Prisma `WorkItemTodo` → wire DTO (Story MOTIR-3808 · MOTIR-3813). Drops the
 * tenancy scalars (`workspaceId` / `workItemId`) and the timestamps no surface
 * reads (`createdAt` / `updatedAt`), and serialises `doneAt` as ISO-8601 so the
 * DTO is JSON-safe across the Server Action boundary.
 */
export function toWorkItemTodoDto(row: WorkItemTodo): WorkItemTodoDto {
  return {
    id: row.id,
    text: row.text,
    commandText: row.commandText,
    executor: row.executor,
    position: row.position,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    doneById: row.doneById,
  };
}

/**
 * A whole list plus its header counts. `done` is counted from the SAME rows
 * that are returned — deliberately, rather than from a second query: a count
 * taken separately can be taken against a different snapshot, and the header
 * would then disagree with the list printed beneath it.
 */
export function toWorkItemTodoListDto(rows: WorkItemTodo[]): WorkItemTodoListDto {
  const todos = rows.map(toWorkItemTodoDto);
  return {
    todos,
    done: todos.filter((t) => t.doneAt !== null).length,
    total: todos.length,
  };
}
