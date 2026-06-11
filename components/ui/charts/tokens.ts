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
} as const;

export type ChartColor = (typeof chartColor)[keyof typeof chartColor];

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
