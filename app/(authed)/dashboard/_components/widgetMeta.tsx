import {
  ArrowUp,
  Bookmark,
  Bug,
  CircleDot,
  Folder,
  Layers,
  Table,
  Tag,
  TrendingUp,
  User,
  Users,
  PieChart,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardWidgetType } from '@prisma/client';
import type { DashboardWidgetSourceDto } from '@/lib/dto/dashboards';
import type { WidgetConfig, DistributionConfig } from '@/lib/dashboards/widgetRegistry';

// Client-safe presentation metadata for the dashboard widgets (Subtask
// 6.3.5). Pure constants + helpers — no server imports — so both the add
// picker, the widget chrome, and the config panels read ONE source. The
// widget-type list is NEVER hard-coded in the UI: components map over the
// 6.3.1 registry's `WIDGET_TYPES`; this map only decorates each known type
// with its glyph + i18n keys (a registry addition surfaces by adding one
// entry here, never by touching component logic).

/** The header glyph per widget type (the 6.3.3 widget-chrome vocabulary). */
export const WIDGET_TYPE_GLYPH: Record<DashboardWidgetType, LucideIcon> = {
  filter_results: Table,
  distribution: PieChart,
  created_vs_resolved: TrendingUp,
};

/** The eight builtin statistic types (the TOTAL statistic registry's static
 * half, in picker order) — each decorated for the distribution config combobox.
 * `labelKey` resolves under the `dashboards.statistic` namespace. */
export const BUILTIN_STATISTICS: ReadonlyArray<{ id: string; labelKey: string; icon: LucideIcon }> =
  [
    { id: 'status', labelKey: 'status', icon: CircleDot },
    { id: 'assignee', labelKey: 'assignee', icon: User },
    { id: 'priority', labelKey: 'priority', icon: ArrowUp },
    { id: 'kind', labelKey: 'kind', icon: Bug },
    { id: 'reporter', labelKey: 'reporter', icon: Users },
    { id: 'sprint', labelKey: 'sprint', icon: Layers },
    { id: 'label', labelKey: 'label', icon: Tag },
    { id: 'component', labelKey: 'component', icon: Folder },
  ];

const BUILTIN_IDS = new Set(BUILTIN_STATISTICS.map((s) => s.id));

/** True for a builtin statistic id (vs a `cf:<id>` custom-field statistic). */
export function isBuiltinStatistic(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The human label for a statistic id: a builtin resolves under
 * `dashboards.statistic.*`; a `cf:<id>` resolves from the supplied custom-field
 * name map (the config panel fetches it), falling back to the raw id.
 */
export function statisticLabel(
  id: string,
  t: Translate,
  customFieldNames?: Record<string, string>,
): string {
  if (isBuiltinStatistic(id)) return t(`statistic.${id}`);
  const cfName = customFieldNames?.[id];
  return cfName ?? id;
}

/** The derived widget title (the schema stores no title — rung-2 deviation,
 * see the PR note): filter-results + created-vs-resolved take their type
 * label; a distribution names its statistic. */
export function deriveWidgetTitle(
  type: DashboardWidgetType,
  config: WidgetConfig,
  t: Translate,
  customFieldNames?: Record<string, string>,
): string {
  if (type === 'distribution') {
    const stat = (config as DistributionConfig).statisticType;
    return t('widgetTitle.distribution', {
      statistic: statisticLabel(stat, t, customFieldNames),
    });
  }
  return t(`widgetTitle.${type}`);
}

/** The widget-chrome "source line" (filter / project name, or the stale note). */
export function sourceLine(source: DashboardWidgetSourceDto, t: Translate): string {
  if (source.kind === 'saved_filter') return t('source.filter', { name: source.name });
  if (source.kind === 'project') return t('source.project', { name: source.name });
  return t('source.stale');
}

/** The leading icon for a source line. */
export const SOURCE_GLYPH = { saved_filter: Bookmark, project: Folder } as const;
