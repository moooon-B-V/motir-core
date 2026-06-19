import type { DashboardWidgetType } from '@prisma/client';
import {
  CREATED_VS_RESOLVED_BUCKETS_MAX,
  CREATED_VS_RESOLVED_DAYS_BACK_MAX,
  FILTER_RESULTS_PAGE_SIZE_MAX,
  STATISTIC_TYPE_ID_MAX_LENGTH,
} from '@/lib/dashboards/constants';
import {
  InvalidDashboardWidgetConfigError,
  UnknownDashboardWidgetTypeError,
} from '@/lib/dashboards/errors';

// The TOTAL per-widget-type registry (Story 6.3 · Subtask 6.3.1 — mistake
// #29): every `dashboard_widget_type` enum value maps to its config schema
// (parse + validate + normalize), its data-source rule, and the renderer /
// editor kinds the 6.3.3 design + 6.3.5 UI key off. An unknown type or a
// malformed config is a typed 422 at the service boundary, never a silent
// pass-through; `tests/integration/dashboards` enumerates the enum against
// this map, so a registry gap fails CI (the totality-guard pattern).
//
// PURE — no db / Prisma-client imports (the lib/filters/registry precedent):
// the registry validates SHAPE; the service resolves referents (does the
// saved filter / project exist in this workspace?) and the 6.3.2 reads
// resolve DATA. Validation is hand-rolled typed parsers, not Zod — the repo
// ships no Zod dependency and the 6.1.1 filter registry set the hand-rolled
// precedent (rung 2 over the card's prose; recorded deviation).
//
// THE DATA-SOURCE RULE (the verified Jira gadget pattern): every widget
// names EXACTLY ONE of `savedFilterId` / `projectId`. Both null or both set
// is a typed 422. The split FK semantics (SetNull stales a filter-sourced
// widget; Cascade takes a project-sourced one) live in the schema; the
// registry's `classifySource` is the read-side inverse — it derives the
// DTO's source descriptor from a stored row, where "both null" can only
// mean a SetNull-staled filter widget (the designed "filter missing" card).

/** The data-source half of a widget write: exactly one id set. */
export interface WidgetSourceInput {
  savedFilterId?: string | null;
  projectId?: string | null;
}

/** A stored widget's source, classified for the DTO (names are decorated by
 * the mapper from a batch lookup — the registry stays pure). */
export type WidgetSourceDescriptor =
  | { kind: 'saved_filter'; savedFilterId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'stale' };

/** Per-type settings, normalized (defaults applied) — what `config` stores. */
export interface FilterResultsConfig {
  pageSize: number;
}
export interface DistributionConfig {
  statisticType: string;
}
export interface CreatedVsResolvedConfig {
  period: 'day' | 'week' | 'month';
  daysBack: number;
  cumulative: boolean;
}
/** The average-age + resolution-time reports share a (period, daysBack) config
 * — the same vertical-bar-over-a-window shape, no cumulative toggle. */
export interface AgeReportConfig {
  period: 'day' | 'week' | 'month';
  daysBack: number;
}
export interface WorkloadConfig {
  measure: 'story_points' | 'issue_count';
}

export type WidgetConfig =
  | FilterResultsConfig
  | DistributionConfig
  | CreatedVsResolvedConfig
  | AgeReportConfig
  | WorkloadConfig;

/** One registry entry — the TOTAL contract every widget type carries. */
export interface WidgetTypeDefinition {
  type: DashboardWidgetType;
  /** Parse + validate + normalize the per-type settings; throws
   * InvalidDashboardWidgetConfigError on any malformed input. */
  parseConfig(raw: unknown): WidgetConfig;
  /** Validate the data-source XOR and classify it; throws
   * InvalidDashboardWidgetConfigError when not exactly one id is set. */
  resolveDataSource(source: WidgetSourceInput): WidgetSourceDescriptor;
  /** The 6.3.5 renderer this type mounts (the 6.3.3 design's widget-body
   * vocabulary). Subtask 8.8.13 adds `bar` (average-age + resolution-time
   * vertical bars) and `hbar` (workload horizontal ranked bars). */
  rendererKind: 'issue_table' | 'donut' | 'difference_area' | 'bar' | 'hbar';
  /** The 6.3.5 config-panel this type opens (the 6.3.3 design's
   * config-panel vocabulary). Subtask 8.8.13 adds `age_report_editor` (the
   * shared period/days-back panel for average-age + resolution-time) and
   * `workload_editor` (the measure toggle). */
  editorKind:
    | 'filter_results_editor'
    | 'distribution_editor'
    | 'created_vs_resolved_editor'
    | 'age_report_editor'
    | 'workload_editor';
}

function asRecord(raw: unknown, type: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidDashboardWidgetConfigError(`${type}: config must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function rejectUnknownKeys(rec: Record<string, unknown>, allowed: string[], type: string): void {
  const unknown = Object.keys(rec).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new InvalidDashboardWidgetConfigError(
      `${type}: unknown config key${unknown.length > 1 ? 's' : ''} ${unknown
        .map((k) => `"${k}"`)
        .join(', ')}.`,
    );
  }
}

/** Shared XOR gate — the verified Jira gadget pattern (project OR saved
 * filter, never both, never neither). All three shipped types accept either
 * source; a future filter-only gadget overrides per entry. */
function requireExactlyOneSource(source: WidgetSourceInput): WidgetSourceDescriptor {
  const savedFilterId = source.savedFilterId ?? null;
  const projectId = source.projectId ?? null;
  if (savedFilterId !== null && typeof savedFilterId !== 'string') {
    throw new InvalidDashboardWidgetConfigError('`savedFilterId` must be a string.');
  }
  if (projectId !== null && typeof projectId !== 'string') {
    throw new InvalidDashboardWidgetConfigError('`projectId` must be a string.');
  }
  const hasFilter = typeof savedFilterId === 'string' && savedFilterId.trim().length > 0;
  const hasProject = typeof projectId === 'string' && projectId.trim().length > 0;
  if (hasFilter === hasProject) {
    throw new InvalidDashboardWidgetConfigError(
      'A widget data source is exactly one of `savedFilterId` or `projectId`.',
    );
  }
  return hasFilter
    ? { kind: 'saved_filter', savedFilterId: savedFilterId as string }
    : { kind: 'project', projectId: projectId as string };
}

function parseIntInRange(
  value: unknown,
  field: string,
  type: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidDashboardWidgetConfigError(
      `${type}: \`${field}\` must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

const filterResults: WidgetTypeDefinition = {
  type: 'filter_results',
  rendererKind: 'issue_table',
  editorKind: 'filter_results_editor',
  resolveDataSource: requireExactlyOneSource,
  parseConfig(raw): FilterResultsConfig {
    const rec = asRecord(raw, 'filter_results');
    rejectUnknownKeys(rec, ['pageSize'], 'filter_results');
    const pageSize =
      rec.pageSize === undefined
        ? FILTER_RESULTS_PAGE_SIZE_MAX
        : parseIntInRange(
            rec.pageSize,
            'pageSize',
            'filter_results',
            1,
            FILTER_RESULTS_PAGE_SIZE_MAX,
          );
    return { pageSize };
  },
};

const distribution: WidgetTypeDefinition = {
  type: 'distribution',
  rendererKind: 'donut',
  editorKind: 'distribution_editor',
  resolveDataSource: requireExactlyOneSource,
  parseConfig(raw): DistributionConfig {
    const rec = asRecord(raw, 'distribution');
    rejectUnknownKeys(rec, ['statisticType'], 'distribution');
    const statisticType = rec.statisticType;
    if (
      typeof statisticType !== 'string' ||
      statisticType.trim().length === 0 ||
      statisticType.length > STATISTIC_TYPE_ID_MAX_LENGTH
    ) {
      throw new InvalidDashboardWidgetConfigError(
        'distribution: `statisticType` is required (a non-empty statistic id).',
      );
    }
    // Shape guard only — the TOTAL statistic-type registry that validates
    // the id against the 6.1 field vocabulary lands with the 6.3.2 reads
    // (an unknown stored id then degrades to the typed stale result).
    return { statisticType: statisticType.trim() };
  },
};

const createdVsResolved: WidgetTypeDefinition = {
  type: 'created_vs_resolved',
  rendererKind: 'difference_area',
  editorKind: 'created_vs_resolved_editor',
  resolveDataSource: requireExactlyOneSource,
  parseConfig(raw): CreatedVsResolvedConfig {
    const rec = asRecord(raw, 'created_vs_resolved');
    rejectUnknownKeys(rec, ['period', 'daysBack', 'cumulative'], 'created_vs_resolved');
    const period = rec.period === undefined ? 'day' : rec.period;
    if (period !== 'day' && period !== 'week' && period !== 'month') {
      throw new InvalidDashboardWidgetConfigError(
        'created_vs_resolved: `period` must be "day", "week", or "month".',
      );
    }
    const daysBack =
      rec.daysBack === undefined
        ? 30
        : parseIntInRange(
            rec.daysBack,
            'daysBack',
            'created_vs_resolved',
            1,
            CREATED_VS_RESOLVED_DAYS_BACK_MAX,
          );
    // The bucket cap (≤120) guards the AGGREGATE read: day-bucketing a year
    // would mint 366 buckets. Enforced here so an over-bucketed config can
    // never be STORED (the 6.3.2 read re-checks defensively).
    const bucketSpan = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    if (Math.ceil(daysBack / bucketSpan) > CREATED_VS_RESOLVED_BUCKETS_MAX) {
      throw new InvalidDashboardWidgetConfigError(
        `created_vs_resolved: \`daysBack\` of ${daysBack} exceeds ${CREATED_VS_RESOLVED_BUCKETS_MAX} "${period}" buckets — widen the period or narrow the window.`,
      );
    }
    const cumulative = rec.cumulative === undefined ? false : rec.cumulative;
    if (typeof cumulative !== 'boolean') {
      throw new InvalidDashboardWidgetConfigError(
        'created_vs_resolved: `cumulative` must be a boolean.',
      );
    }
    return { period, daysBack, cumulative };
  },
};

/** Parse + validate a (period, daysBack) config — the shared core of
 * created-vs-resolved and the 8.8.13 age reports (same window + bucket-cap
 * rule). The `type` label personalizes the error messages. */
function parsePeriodWindow(
  raw: unknown,
  type: string,
): { period: 'day' | 'week' | 'month'; daysBack: number } {
  const rec = asRecord(raw, type);
  rejectUnknownKeys(rec, ['period', 'daysBack'], type);
  const period = rec.period === undefined ? 'day' : rec.period;
  if (period !== 'day' && period !== 'week' && period !== 'month') {
    throw new InvalidDashboardWidgetConfigError(
      `${type}: \`period\` must be "day", "week", or "month".`,
    );
  }
  const daysBack =
    rec.daysBack === undefined
      ? 30
      : parseIntInRange(rec.daysBack, 'daysBack', type, 1, CREATED_VS_RESOLVED_DAYS_BACK_MAX);
  const bucketSpan = period === 'day' ? 1 : period === 'week' ? 7 : 30;
  if (Math.ceil(daysBack / bucketSpan) > CREATED_VS_RESOLVED_BUCKETS_MAX) {
    throw new InvalidDashboardWidgetConfigError(
      `${type}: \`daysBack\` of ${daysBack} exceeds ${CREATED_VS_RESOLVED_BUCKETS_MAX} "${period}" buckets — widen the period or narrow the window.`,
    );
  }
  return { period, daysBack };
}

/** The average-age + resolution-time reports (Subtask 8.8.13) — a vertical bar
 * over a (period, daysBack) window. Two registry types sharing one config
 * parser + renderer (`bar`) + editor (`age_report_editor`); they differ only in
 * the read the service runs and the chart's colour token. */
const averageAge: WidgetTypeDefinition = {
  type: 'average_age',
  rendererKind: 'bar',
  editorKind: 'age_report_editor',
  resolveDataSource: requireExactlyOneSource,
  parseConfig(raw): AgeReportConfig {
    return parsePeriodWindow(raw, 'average_age');
  },
};

const resolutionTime: WidgetTypeDefinition = {
  type: 'resolution_time',
  rendererKind: 'bar',
  editorKind: 'age_report_editor',
  resolveDataSource: requireExactlyOneSource,
  parseConfig(raw): AgeReportConfig {
    return parsePeriodWindow(raw, 'resolution_time');
  },
};

const workload: WidgetTypeDefinition = {
  type: 'workload',
  rendererKind: 'hbar',
  editorKind: 'workload_editor',
  resolveDataSource: requireExactlyOneSource,
  parseConfig(raw): WorkloadConfig {
    const rec = asRecord(raw, 'workload');
    rejectUnknownKeys(rec, ['measure'], 'workload');
    const measure = rec.measure === undefined ? 'story_points' : rec.measure;
    if (measure !== 'story_points' && measure !== 'issue_count') {
      throw new InvalidDashboardWidgetConfigError(
        'workload: `measure` must be "story_points" or "issue_count".',
      );
    }
    return { measure };
  },
};

/** The registry — TOTAL over `DashboardWidgetType` (the `satisfies` clause
 * makes a missing enum value a compile error; the enumeration test makes it
 * a runtime failure too). */
export const WIDGET_REGISTRY = {
  filter_results: filterResults,
  distribution,
  created_vs_resolved: createdVsResolved,
  average_age: averageAge,
  resolution_time: resolutionTime,
  workload,
} as const satisfies Record<DashboardWidgetType, WidgetTypeDefinition>;

/** Every registered type, for enumeration (tests, the 6.3.5 add-picker). */
export const WIDGET_TYPES = Object.keys(WIDGET_REGISTRY) as DashboardWidgetType[];

/** Look up a type from untrusted input — the typed-422 gate (mistake #29:
 * a lookup keyed off an enum is total; anything else is rejected, never
 * silently passed through). */
export function widgetDefinition(type: string): WidgetTypeDefinition {
  const def = (WIDGET_REGISTRY as Record<string, WidgetTypeDefinition>)[type];
  if (!def) throw new UnknownDashboardWidgetTypeError(type);
  return def;
}

/** Classify a STORED row's source for the DTO. Write-time XOR means "both
 * null" can only be a SetNull-staled filter widget — the designed "filter
 * missing" card (project-sourced widgets Cascade away instead, so they
 * never stale). */
export function classifyStoredSource(row: {
  savedFilterId: string | null;
  projectId: string | null;
}): WidgetSourceDescriptor {
  if (row.savedFilterId) return { kind: 'saved_filter', savedFilterId: row.savedFilterId };
  if (row.projectId) return { kind: 'project', projectId: row.projectId };
  return { kind: 'stale' };
}
