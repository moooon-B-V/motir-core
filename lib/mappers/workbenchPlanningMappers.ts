import type { GeneratingPlanRow } from '@/lib/repositories/planRepository';
import type { ToResumePlanningSessionDto, WorkbenchPlanningRowDto } from '@/lib/dto/home';
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

/**
 * One failed planning session of the reader's, as a To resume entry (MOTIR-7914). The
 * naming is {@link toWorkbenchPlanningRowDto}'s — `targets` is composed the same way —
 * and `failure` is carried as stored: the reason stays the stable code (the render
 * translates it), the stop point stays the ref and title the walk reported.
 */
export function toToResumePlanningSessionDto(
  row: {
    id: string;
    targetKeys: readonly string[];
    failedAt: Date | null;
    failureReason: string | null;
    failureStopPhase: 'lay' | 'author' | null;
    failureStopRef: string | null;
    failureStopTitle: string | null;
    latestPlan: { id: string; title: string | null } | null;
  },
  projectName: string,
  targetTitles: ReadonlyMap<string, string>,
  progress: PlanProgressSnapshot | null,
): ToResumePlanningSessionDto {
  return {
    sessionId: row.id,
    planId: row.latestPlan?.id ?? null,
    title: row.latestPlan?.title ?? null,
    projectName,
    targets: row.targetKeys.map((key) => ({ key, title: targetTitles.get(key) ?? null })),
    failure: {
      failedAt: (row.failedAt ?? new Date(0)).toISOString(),
      reason: row.failureReason ?? 'internal',
      stopPhase: row.failureStopPhase,
      stopRef: row.failureStopRef,
      stopTitle: row.failureStopTitle,
    },
    progress,
  };
}
