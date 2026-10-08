import type { GeneratingPlanRow } from '@/lib/repositories/planRepository';
import type { WorkbenchPlanningRowDto } from '@/lib/dto/home';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';

// The Workbench Planning tab's row mapper (Story MOTIR-7820 · MOTIR-7828) — a
// plan row from `planRepository.listGeneratingRequestedBy` plus the titles of its
// session's targets and its progress snapshot, to the wire DTO. Pure.

/**
 * One row. `targetTitles` is keyed by work-item identifier, within the plan's
 * project; a key absent from it no longer resolves and maps to a null title.
 * `progress` is carried through unmodified.
 */
export function toWorkbenchPlanningRowDto(
  row: GeneratingPlanRow,
  targetTitles: ReadonlyMap<string, string>,
  progress: PlanProgressSnapshot,
): WorkbenchPlanningRowDto {
  return {
    planId: row.id,
    sessionId: row.sessionId,
    title: row.title,
    projectName: row.project.name,
    targets: (row.session?.targetKeys ?? []).map((key) => ({
      key,
      title: targetTitles.get(key) ?? null,
    })),
    author: {
      source: row.authorSource,
      harness: row.authorHarness,
      model: row.authorModel,
      origin: row.origin,
    },
    createdAt: row.createdAt.toISOString(),
    progress,
  };
}
