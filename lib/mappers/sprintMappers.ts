import type { Sprint } from '@prisma/client';
import type { SprintDto, SprintStateDto } from '@/lib/dto/sprints';

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
  };
}
