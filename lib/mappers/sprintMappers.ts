import type { Sprint, WorkItem } from '@prisma/client';
import type {
  SprintDto,
  SprintReportDto,
  SprintReportPointsDto,
  SprintStateDto,
} from '@/lib/dto/sprints';
import type { RankedIssuePageDto } from '@/lib/dto/backlog';
import { toWorkItemSummaryDto } from '@/lib/mappers/workItemMappers';

// Prisma → DTO converter for the sprint domain (Story 4.1 · Subtask 4.1.3). The
// service calls this just before returning so no Prisma row shape (Date objects,
// the Prisma `SprintState` enum) leaks across the API boundary. Mirrors
// `lib/mappers/boardMappers.ts`.

/**
 * Map a `sprint` row to a `SprintDto`. `issueCount` is supplied by the service
 * (a separate aggregate read — `workItemRepository.countSprintIssues`; 0 for a
 * just-created sprint) since it is not a column on the row. The Prisma
 * `SprintState` enum is string-compatible with the `SprintStateDto` union, the
 * same cast `boardMappers` uses for `BoardType`. Dates normalize to ISO-8601
 * strings (or null).
 */
export function toSprintDto(row: Sprint, issueCount: number): SprintDto {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    state: row.state as SprintStateDto,
    startDate: row.startDate ? row.startDate.toISOString() : null,
    endDate: row.endDate ? row.endDate.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    sequence: row.sequence,
    issueCount,
    // The scope-lock baseline (Story 4.4.2): null until the sprint is started.
    // `committedPoints` is a Prisma `Decimal` on the row — narrow to a JS number
    // for the wire (fractional-safe; bounded by Decimal(8,2)).
    committedPoints: row.committedPoints === null ? null : row.committedPoints.toNumber(),
    committedIssueCount: row.committedIssueCount,
  };
}

/**
 * Slice a `take + 1`-sized read into one bounded `RankedIssuePageDto` (Story
 * 4.4.4 — the sprint report's completed / incomplete lists). The repo reads one
 * extra row to detect a next page: when present, the page is exactly `take` rows
 * and `nextCursor` is the last kept row's id (pass it back for the next page);
 * otherwise `nextCursor` is null. `totalCount` is the full grouped aggregate
 * behind the page (the "N completed / M incomplete" header). Rows map through the
 * shared `toWorkItemSummaryDto` so no Prisma row leaks. Mirrors
 * `backlogService.buildPage`.
 */
export function toSprintReportPage(
  rows: WorkItem[],
  take: number,
  totalCount: number,
): RankedIssuePageDto {
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const nextCursor = hasMore ? rows[take - 1]!.id : null;
  return { items: page.map(toWorkItemSummaryDto), nextCursor, totalCount };
}

/**
 * Assemble the `SprintReportDto` (Story 4.4.4) from the pieces the service
 * computes — the points summary, the two already-paginated issue pages, and the
 * scope-change count — plus the sprint's id + state. A thin assembler (the heavy
 * row→DTO conversion lives in `toSprintReportPage` / `toWorkItemSummaryDto`),
 * kept here so the report's wire shape is owned by the mapper layer, not the
 * service (CLAUDE.md: the service maps just before returning).
 */
export function toSprintReportDto(input: {
  sprintId: string;
  state: SprintStateDto;
  points: SprintReportPointsDto;
  completed: RankedIssuePageDto;
  incomplete: RankedIssuePageDto;
  addedAfterStart: number;
}): SprintReportDto {
  return {
    sprintId: input.sprintId,
    state: input.state,
    points: input.points,
    completed: input.completed,
    incomplete: input.incomplete,
    addedAfterStart: input.addedAfterStart,
  };
}
