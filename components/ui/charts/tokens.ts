/**
 * Chart series colours (Story 4.6.2).
 *
 * Every colour a chart renders MUST route through one of the Tier-3
 * `--el-chart-*` element tokens (added to `app/globals.css`), NEVER a raw
 * Tier-0 `--color-*` — the swap-layer discipline in `motir-core/CLAUDE.md`.
 * These constants are the typed handles: pass `chartColor.actual` (a
 * `var(--el-chart-actual)` string) as a series/bar/reference colour and the
 * colour stays inside the swap layer (it re-skins under dark mode + a future
 * `data-palette` automatically).
 *
 * Story 6.3 (dashboards) reuses this map; add a new role by adding a new
 * `--el-chart-*` token in globals.css + an entry here — never by reaching for
 * a `--color-*` in chart code.
 */
export const chartColor = {
  /** Burndown ideal guideline (dashed). */
  guideline: 'var(--el-chart-guideline)',
  /** Burndown actual remaining (the step line). */
  actual: 'var(--el-chart-actual)',
  /** Scope-change marker. */
  scope: 'var(--el-chart-scope)',
  /** Velocity committed bar. */
  committed: 'var(--el-chart-committed)',
  /** Velocity completed bar. */
  completed: 'var(--el-chart-completed)',
  /** Velocity average reference line (dashed). */
  average: 'var(--el-chart-average)',
  /** Axis-toned reference rule (the burndown's "today" vertical marker). */
  axis: 'var(--el-chart-axis)',
  /** Distribution donut — the "None"/unset segment (always neutral grey, never a ramp slot). */
  categoricalNone: 'var(--el-chart-cat-none)',
  /** Created-vs-resolved — the created series line. */
  created: 'var(--el-chart-created)',
  /** Created-vs-resolved — the resolved series line. */
  resolved: 'var(--el-chart-resolved)',
  /** Difference fill where created outpaces resolved (backlog growing — red). */
  deficit: 'var(--el-chart-deficit)',
  /** Difference fill where resolved outpaces created (catching up — green). */
  surplus: 'var(--el-chart-surplus)',
} as const;

export type ChartColor = (typeof chartColor)[keyof typeof chartColor];

/**
 * The categorical donut ramp (Story 6.3.4) — the distribution donut cycles
 * these `--el-chart-cat-*` tokens in order for its segments. The "None"/unset
 * group is NOT a ramp slot; it always uses `chartColor.categoricalNone`
 * (neutral grey). Beyond the ramp length the donut rolls the remainder into a
 * "+N more" legend row rather than repeating an indistinguishable hue.
 */
export const chartCategorical: readonly string[] = [
  'var(--el-chart-cat-1)',
  'var(--el-chart-cat-2)',
  'var(--el-chart-cat-3)',
  'var(--el-chart-cat-4)',
  'var(--el-chart-cat-5)',
  'var(--el-chart-cat-6)',
  'var(--el-chart-cat-7)',
];

/** Margins around a chart's plot area (the band that holds axes + labels). */
export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A single axis tick: where it sits in data space + the text drawn for it. */
export interface AxisTick {
  value: number;
  label: string;
}

/** One axis's domain, ticks, and optional title. */
export interface ChartAxis {
  domain: [number, number];
  ticks: AxisTick[];
  title?: string;
}

/** A legend entry — rendered as TEXT beside its swatch (finding #35). */
export interface ChartLegendItem {
  label: string;
  color: string;
  /** `swatch` = filled block (bars); `line` = solid rule; `dash` = dashed rule. */
  kind?: 'swatch' | 'line' | 'dash';
  /** Bold the label (the primary series) vs. a secondary/reference entry. */
  emphasis?: boolean;
}
