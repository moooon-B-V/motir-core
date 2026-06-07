import type { Board, BoardColumn, WorkItem } from '@prisma/client';
import type {
  BoardCardDto,
  BoardColumnConfigDto,
  BoardDto,
  BoardSwimlaneGroupByDto,
  BoardTypeDto,
} from '@/lib/dto/boards';

// Prisma → DTO converters for the board domain. The service calls these just
// before returning so no Prisma row shape (Date objects, Prisma enums) leaks
// across the API boundary. Mirrors `lib/mappers/workItemMappers.ts`.

/**
 * Map a `board` row to a `BoardDto` (the config shape, Subtask 3.3.3). The
 * Prisma `BoardType` / `BoardSwimlaneGroupBy` enums are string-compatible with
 * their DTO unions, so the cast is the same one `getBoard` uses for `type`.
 */
export function toBoardDto(row: Board): BoardDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as BoardTypeDto,
    swimlaneGroupBy: row.swimlaneGroupBy as BoardSwimlaneGroupByDto,
  };
}

/**
 * Map a `board_column` row to a `BoardColumnConfigDto` (Subtask 3.3.3 — the WIP
 * config write return). `position` is already the opaque fractional-index
 * string on the row; `wipLimit` is the nullable Int.
 */
export function toBoardColumnConfigDto(row: BoardColumn): BoardColumnConfigDto {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    wipLimit: row.wipLimit,
  };
}

/**
 * Map a `work_item` row + its readiness flag to a `BoardCardDto`. `dueDate` is
 * normalized to a wire-safe ISO string; `position` is already a fractional-
 * index string on the row. `ready` is computed by the caller (the service,
 * via `workItemsService.getReadiness`) — the mapper stays a pure shape
 * converter and does not read the link graph itself.
 */
export function toBoardCardDto(row: WorkItem, opts: { ready: boolean }): BoardCardDto {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    position: row.position,
    ready: opts.ready,
  };
}
