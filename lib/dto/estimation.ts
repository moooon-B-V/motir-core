// DTO types for the estimation domain (Story 4.3 · Subtask 4.3.3). The shapes
// that cross the API boundary — no Prisma row / enum / Decimal leaks (the
// `EstimationStatistic` / `PointScale` enums become string unions, point totals
// become plain `number`s). The 4.3.4 / 4.3.5 / 4.3.6 UI binds to these.

/**
 * Which value is THE planning estimate the surfaces display + the roll-ups sum
 * (`project.estimationStatistic`) — the three Jira estimation statistics. Wire
 * form of the Prisma `EstimationStatistic` enum. Default `story_points`.
 */
export type EstimationStatisticDto = 'story_points' | 'time_estimate' | 'issue_count';

/**
 * The suggested-value deck the estimate picker offers (`project.pointScale`) —
 * it does NOT hard-constrain entry (story points stay a free numeric value).
 * Wire form of the Prisma `PointScale` enum. Default `fibonacci`.
 */
export type PointScaleDto = 'fibonacci' | 'linear' | 'custom';

/**
 * A project's estimation configuration as the API returns it. `customScaleValues`
 * is the project-defined deck, used (and required non-empty) only when
 * `pointScale === 'custom'`.
 */
export interface EstimationConfigDto {
  estimationStatistic: EstimationStatisticDto;
  pointScale: PointScaleDto;
  customScaleValues: number[];
}

/**
 * Patch input to `estimationService.updateEstimationConfig`. Every field is
 * optional — an absent field is left unchanged. The service validates the
 * effective (patch-merged) config (enum membership; a non-empty numeric
 * `customScaleValues` when the effective scale is `custom`).
 */
export interface UpdateEstimationConfigInput {
  estimationStatistic?: EstimationStatisticDto;
  pointScale?: PointScaleDto;
  customScaleValues?: number[];
}

/**
 * The sprint points roll-up (`estimationService.rollupForSprint`). `committed`
 * is the configured statistic summed over all the sprint's non-archived issues;
 * `completed` is the same sum scoped to issues whose status maps to a
 * `category = 'done'` workflow status; `remaining = committed − completed`,
 * floored at 0. A wholly unestimated sprint returns `{ 0, 0, 0 }` (the DTO stays
 * total; the UI owns the "—" presentation).
 */
export interface SprintPointsDto {
  committed: number;
  completed: number;
  remaining: number;
}

/**
 * The epic/parent subtree roll-up (`estimationService.rollupForParent`):
 * `total` is the configured statistic summed over the parent's DESCENDANTS at
 * any depth (distinct from the parent's OWN estimate). An unestimated subtree
 * returns `{ total: 0 }`.
 */
export interface ParentRollupDto {
  total: number;
}
