import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type { VelocityDto, VelocitySprintDto } from '@/lib/dto/reports';

// Pure assemblers for the reports domain (Story 4.6 · Subtask 4.6.4). The
// service composes the per-sprint figures (committed baseline + done-category
// roll-up) then calls this to derive the average + shape the DTO — no Prisma
// enum / Decimal leaks across the API boundary. Mirrors
// `lib/mappers/estimationMappers.ts`.

/**
 * Build a `VelocityDto` from the per-sprint `{ committed, completed }` data
 * (already ordered oldest→newest for the X axis) + the configured statistic.
 * `averageCompleted` is the mean of `completed` over the returned sprints — the
 * planning forecast — rounded to two decimals to avoid float-noise display, and
 * `0` when there is no history (the low-history state; the UI renders "not
 * enough history yet"). PURE: no I/O, unit-testable in isolation.
 */
export function toVelocityDto(
  sprints: VelocitySprintDto[],
  statistic: EstimationStatisticDto,
): VelocityDto {
  const averageCompleted =
    sprints.length === 0
      ? 0
      : Math.round((sprints.reduce((sum, s) => sum + s.completed, 0) / sprints.length) * 100) / 100;
  return { sprints, averageCompleted, statistic };
}
