import type { WorkItemTodo } from '@/generated/prisma/client';
import type {
  TodoProgressDto,
  WorkItemTodoDto,
  WorkItemTodoListDto,
} from '@/lib/dto/workItemTodos';

/**
 * The row shape the mappers need: the to-do plus the (optional) user who
 * ticked it, selected down to what the wire carries. Declared here rather than
 * as a `Prisma.WorkItemTodoGetPayload` so a caller can hand over any row that
 * satisfies it — which is what lets the action tests assert the mapping without
 * a database round trip.
 */
export type WorkItemTodoRow = WorkItemTodo & {
  doneBy?: { id: string; name: string } | null;
};

/**
 * Prisma `WorkItemTodo` → wire DTO (Story MOTIR-3808 · MOTIR-3814). Drops the
 * tenancy scalars (`workspaceId` / `workItemId`) and the timestamps no surface
 * reads (`createdAt` / `updatedAt`), and serialises `doneAt` as ISO-8601 so the
 * DTO is JSON-safe across the Server Action boundary.
 *
 * `done` is DERIVED here from `doneAt` — the database stores one fact and the
 * wire carries both forms, which is the only arrangement in which they cannot
 * disagree.
 */
export function toWorkItemTodoDto(row: WorkItemTodoRow): WorkItemTodoDto {
  return {
    id: row.id,
    text: row.text,
    // Explicitly normalised: a row with no command is `null` on the wire, never
    // `''`, because `commandText === null` is the client's test for "is this a
    // command row?" and an empty string would answer it wrongly.
    commandText: row.commandText === null || row.commandText === '' ? null : row.commandText,
    executor: row.executor,
    position: row.position,
    done: row.doneAt !== null,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    doneBy: row.doneBy ? { id: row.doneBy.id, name: row.doneBy.name } : null,
  };
}

/** The header's two numbers, counted from the rows that are being returned. */
export function toTodoProgressDto(rows: Pick<WorkItemTodo, 'doneAt'>[]): TodoProgressDto {
  return { done: rows.filter((r) => r.doneAt !== null).length, total: rows.length };
}

/**
 * A whole list plus its progress. `done` is counted from the SAME rows that are
 * returned — deliberately, rather than from a second query: a count taken
 * separately can be taken against a different snapshot, and the header would
 * then disagree with the list printed beneath it.
 */
export function toWorkItemTodoListDto(rows: WorkItemTodoRow[]): WorkItemTodoListDto {
  return { items: rows.map(toWorkItemTodoDto), progress: toTodoProgressDto(rows) };
}
