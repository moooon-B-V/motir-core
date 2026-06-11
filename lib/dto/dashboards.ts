import type { DashboardAccess, DashboardLayout, DashboardWidgetType } from '@prisma/client';
import type { WidgetConfig } from '@/lib/dashboards/widgetRegistry';

// Dashboard DTOs (Story 6.3 · Subtask 6.3.1) — what crosses the API
// boundary. Mappers in lib/mappers/dashboardMappers.ts build these; routes
// return them verbatim (the lib/dto/savedFilters pattern).

/** One switcher / home-list row (the bounded `listDashboards` read). */
export interface DashboardSummaryDto {
  id: string;
  name: string;
  access: DashboardAccess;
  layout: DashboardLayout;
  owner: { id: string; name: string };
  /** The actor's own relationship — drives the owner-only edit affordances
   * (the 6.3.3 view-vs-edit split) without a second request. */
  isOwner: boolean;
  widgetCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A widget's data source, classified for the renderer:
 *   saved_filter / project — a live referent + its display name (the 6.3.3
 *     widget-chrome "source line");
 *   stale — the referent was deleted (a SetNull-staled filter widget): the
 *     designed "filter missing" card with the reconfigure affordance. */
export type DashboardWidgetSourceDto =
  | { kind: 'saved_filter'; savedFilterId: string; name: string }
  | { kind: 'project'; projectId: string; name: string }
  | { kind: 'stale' };

/** One widget on the grid (the `getDashboard` read, render order). */
export interface DashboardWidgetDto {
  id: string;
  type: DashboardWidgetType;
  column: number;
  position: string;
  /** Normalized per-type settings (the registry's parse output). */
  config: WidgetConfig;
  source: DashboardWidgetSourceDto;
  /** The registry's UI contract — which body the 6.3.5 grid mounts and
   * which config panel it opens. The UI renders FROM these kinds (never a
   * hard-coded type list), so a registry addition needs zero UI changes. */
  rendererKind: string;
  editorKind: string;
}

/** The full grid (the `getDashboard` read). */
export interface DashboardDetailDto extends DashboardSummaryDto {
  widgets: DashboardWidgetDto[];
}
