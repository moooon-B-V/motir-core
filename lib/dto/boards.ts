// DTOs for the board domain (Story 3.1). The wire-safe shapes the board
// services return — no Prisma row (Date objects, Decimal instances, Prisma
// enums) crosses the API boundary; mappers in `lib/mappers/boardMappers.ts`
// produce these.
//
// `BoardCardDto` is the projection of a `work_item` AS A BOARD CARD. It is
// introduced here by the move path (Subtask 3.1.5) — the first board write —
// and is the SAME card shape the read projection (Subtask 3.1.4) returns for
// every column, so the 3.2 UI reconciles an optimistic move against an
// identically-shaped card. (3.1.4 may enrich it with a resolved assignee
// summary for the projection; the move path populates `assigneeId` — the id is
// what the optimistic-update reconcile needs, the UI already holds the avatar.)

import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

/** Board kind — mirrors the Prisma `BoardType` enum (Story 3.1.1). */
export type BoardTypeDto = 'kanban' | 'scrum';

/**
 * One work item rendered as a board card. The row-render fields a column card
 * shows (kind icon, identifier, title, assignee, status, priority) plus the
 * board wiring (`position` for rank, `parentId`), the schedule fields a card
 * surfaces (`dueDate`, `estimateMinutes`), and the finding-#21 readiness
 * signal (`ready` is false when an open `is_blocked_by` blocker remains) so a
 * card can show a blocked indicator. `dueDate` is normalized to an ISO string;
 * `position` is already the opaque fractional-index string on the row.
 */
export interface BoardCardDto {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  position: string;
  /** False iff an `is_blocked_by` blocker remains in a non-terminal status (finding #21). */
  ready: boolean;
}

/**
 * Where a card is dropped: the target column, and the rank neighbours that
 * bracket the drop slot. `beforeId` is the card immediately ABOVE the slot,
 * `afterId` the card immediately BELOW; the moved card's new `position` sorts
 * strictly between their positions. Either may be omitted — the slot at the
 * top of a column has no `beforeId`, the bottom has no `afterId`, and a drop
 * into an empty column has neither.
 */
export interface MoveCardTarget {
  toColumnId: string;
  beforeId?: string;
  afterId?: string;
}

/**
 * The result of `boardsService.moveCard`: the moved card in its post-move
 * state, the status it ended up in (`appliedStatus` — unchanged for an
 * in-column reorder, the resolved target status for a cross-column move), and
 * the resolved target column, so the UI can reconcile its optimistic update.
 */
export interface MoveCardResultDto {
  card: BoardCardDto;
  appliedStatus: string;
  column: { id: string; name: string };
}

/**
 * One column of the board projection (Subtask 3.1.4): the column meta, its
 * mapped status keys, a BOUNDED first page of cards (ordered by rank, or by
 * recency for a terminal column), the FULL count of cards in the column
 * (`totalCount` — the denominator the UI shows, independent of how many are
 * loaded), and a `cursor` for lazy "load more" (null when the column has no
 * further pages). The board NEVER returns every card (finding #57); the 3.2 UI
 * pages with `cursor` and virtualizes a tall column.
 */
export interface BoardColumnDto {
  id: string;
  name: string;
  /** Fractional-index sort key (opaque string). */
  position: string;
  /** WIP limit (Story 3.3 enforces; 3.1.4 only surfaces it). */
  wipLimit: number | null;
  /** The workflow status keys this column maps (the statuses its cards hold). */
  statusKeys: string[];
  cards: BoardCardDto[];
  totalCount: number;
  cursor: string | null;
}

/**
 * The board read projection (Subtask 3.1.4): the default board's columns (in
 * `position` order), each with its bounded first page of cards, plus
 * `unmappedStatuses` — every project workflow status mapped to NO column
 * (Jira's behaviour: surfaced, never silently dropped, so the 3.2 UI can offer
 * to map them). The board itself stores no card placement; a card's column is
 * derived from its `work_item.status`.
 */
export interface BoardProjectionDto {
  boardId: string;
  name: string;
  type: BoardTypeDto;
  columns: BoardColumnDto[];
  unmappedStatuses: WorkflowStatusDto[];
}

/**
 * One lazy "load more" page for a single column (`boardsService.loadColumnCards`
 * / the 3.1.6 `GET …/columns/[id]/cards` route): the next slice of cards plus
 * the cursor for the page after it (null at the end of the column's bounded
 * window). Same `BoardCardDto` shape the projection returns.
 */
export interface PagedColumnCardsDto {
  cards: BoardCardDto[];
  cursor: string | null;
}
