import type { Board, BoardColumn, BoardColumnStatus, WorkItem } from '@prisma/client';
import type {
  BoardCardDto,
  BoardColumnConfigDto,
  BoardColumnStatusDto,
  BoardDto,
  BoardSummaryDto,
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
 * Map a `board` row to a `BoardSummaryDto` (the switcher shape, Subtask 3.7.3).
 * Like `toBoardDto` but carries `isDefault` + `position` (the switcher's badge +
 * order) instead of `swimlaneGroupBy` (a projection concern). `position` is
 * already the opaque fractional-index string on the row.
 */
export function toBoardSummaryDto(row: Board): BoardSummaryDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as BoardTypeDto,
    isDefault: row.isDefault,
    position: row.position,
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
 * Map a `board_column_status` row to a `BoardColumnStatusDto` (Subtask 3.6.2 —
 * the map-status write return). Just the mapping edge's identity (board /
 * column / status ids) — the rows carry timestamps + a workspace/project FK the
 * wire shape omits.
 */
export function toBoardColumnStatusDto(row: BoardColumnStatus): BoardColumnStatusDto {
  return {
    boardId: row.boardId,
    columnId: row.columnId,
    statusId: row.statusId,
  };
}

/**
 * Map a `work_item` row + its readiness flag to a `BoardCardDto`. `dueDate` is
 * normalized to a wire-safe ISO string; `position` is already a fractional-
 * index string on the row. `ready` is computed by the caller (the service,
 * via `workItemsService.getReadiness`) — the mapper stays a pure shape
 * converter and does not read the link graph itself. `swimlaneKey` (Subtask
 * 3.3.4) is the caller-resolved lane key under the board's group-by; it is
 * OMITTED from the DTO when `undefined` (the `none`/flat board), so the flat
 * projection is byte-for-byte the 3.1.4 card shape.
 */
export function toBoardCardDto(
  row: WorkItem,
  opts: { ready: boolean; swimlaneKey?: string },
): BoardCardDto {
  const dto: BoardCardDto = {
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
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    position: row.position,
    ready: opts.ready,
  };
  if (opts.swimlaneKey !== undefined) dto.swimlaneKey = opts.swimlaneKey;
  return dto;
}
