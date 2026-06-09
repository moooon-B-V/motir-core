import type { EstimationStatistic, PointScale } from '@prisma/client';
import type {
  EstimationConfigDto,
  EstimationStatisticDto,
  PointScaleDto,
  SprintPointsDto,
} from '@/lib/dto/estimation';

// Prisma → DTO converters for the estimation domain (Story 4.3 · Subtask
// 4.3.3). The service calls these just before returning so no Prisma enum
// leaks across the API boundary. Mirrors `lib/mappers/sprintMappers.ts`.

/**
 * Map a project's estimation columns to an `EstimationConfigDto`. Accepts the
 * full `Project` row or the `projectRepository.findEstimationConfig` projection
 * (both carry the three fields). The Prisma `EstimationStatistic` / `PointScale`
 * enums are string-compatible with their DTO unions (the same cast
 * `sprintMappers` uses for `SprintState`). `customScaleValues` is copied so the
 * DTO never aliases the Prisma row's array.
 */
export function toEstimationConfigDto(row: {
  estimationStatistic: EstimationStatistic;
  pointScale: PointScale;
  customScaleValues: number[];
}): EstimationConfigDto {
  return {
    estimationStatistic: row.estimationStatistic as EstimationStatisticDto,
    pointScale: row.pointScale as PointScaleDto,
    customScaleValues: [...row.customScaleValues],
  };
}

/**
 * Build a `SprintPointsDto` from the bounded-aggregate `committed` / `completed`
 * totals (`workItemRepository.sumPointsForSprint`). `remaining` is derived here
 * — `committed − completed`, floored at 0 so a stale `completed` (an issue
 * re-opened after a points edit) never yields a negative remaining.
 */
export function toSprintPointsDto(committed: number, completed: number): SprintPointsDto {
  return {
    committed,
    completed,
    remaining: Math.max(0, committed - completed),
  };
}
