import type { SprintDto, SprintStateDto } from '@/lib/dto/sprints';

// The sprint picker's list and default for the sprint-scoped report pages
// (Story MOTIR-8919): Burndown and the Sprint report offer the SAME sprints in
// the SAME order and open the SAME default, so the rule lives here once instead
// of being derived inline in two pages. Pure (no I/O, no React).

/** One entry in a report's sprint picker. */
export interface ReportPickerSprint {
  id: string;
  name: string;
  state: SprintStateDto;
}

/**
 * The started sprints a report can show, and the one it opens by default.
 *
 * - `pickerSprints` — the ACTIVE sprint first, then COMPLETED sprints newest to
 *   oldest. A planned sprint has no window to report on, so it is not offered.
 * - `defaultSprint` — the active sprint, else the most recently completed one,
 *   else `null` when nothing has started.
 *
 * `sprints` is `sprintsService.listByProject`'s order (oldest → newest by
 * sequence), so the most recent completed sprint is the last one.
 */
export function pickReportSprints(sprints: SprintDto[]): {
  pickerSprints: ReportPickerSprint[];
  defaultSprint: ReportPickerSprint | null;
} {
  const active = sprints.find((s) => s.state === 'active') ?? null;
  const completed = sprints.filter((s) => s.state === 'complete');
  const pickerSprints = [...(active ? [active] : []), ...[...completed].reverse()].map((s) => ({
    id: s.id,
    name: s.name,
    state: s.state,
  }));
  return { pickerSprints, defaultSprint: pickerSprints[0] ?? null };
}
