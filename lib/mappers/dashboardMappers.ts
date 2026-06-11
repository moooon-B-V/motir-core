import type { Dashboard, DashboardWidget } from '@prisma/client';
import { widgetDefinition } from '@/lib/dashboards/widgetRegistry';
import type {
  DashboardDetailDto,
  DashboardSummaryDto,
  DashboardWidgetDto,
  DashboardWidgetSourceDto,
} from '@/lib/dto/dashboards';

// Prisma → DTO converters for dashboards (Story 6.3 · Subtask 6.3.1).
// Drops workspaceId (implicit in the route's workspace gate) and the raw FK
// scalars (re-shaped into the classified `source` descriptor). The widget's
// stored `config` re-runs the registry parser on the way OUT, so a stored
// config always crosses the boundary normalized — and a config persisted by
// an older registry version re-normalizes instead of leaking drift.

/** The repository's list/detail row shape: the row plus the SQL-aggregated
 * owner + widget count (fetched in the same query — never a JS count). */
export interface DashboardWithFacts extends Dashboard {
  owner: { id: string; name: string };
  _count: { widgets: number };
}

/** A widget row decorated with its referents' display names (the same-query
 * relation selects — the mapper never reaches for the db). */
export interface DashboardWidgetWithNames extends DashboardWidget {
  savedFilter: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}

export function toDashboardSummaryDto(
  row: DashboardWithFacts,
  actorUserId: string,
): DashboardSummaryDto {
  return {
    id: row.id,
    name: row.name,
    access: row.access,
    layout: row.layout,
    owner: { id: row.owner.id, name: row.owner.name },
    isOwner: row.ownerId === actorUserId,
    widgetCount: row._count.widgets,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The same classification as the registry's `classifyStoredSource`, read
 * off the LOADED relations (an FK scalar and its same-query relation select
 * are set-or-null together, so branching on the relation needs no dead
 * `?? ''` fallback arms): both null can only be a SetNull-staled filter
 * widget. */
function toSourceDto(row: DashboardWidgetWithNames): DashboardWidgetSourceDto {
  if (row.savedFilter) {
    return { kind: 'saved_filter', savedFilterId: row.savedFilter.id, name: row.savedFilter.name };
  }
  if (row.project) {
    return { kind: 'project', projectId: row.project.id, name: row.project.name };
  }
  return { kind: 'stale' };
}

export function toDashboardWidgetDto(row: DashboardWidgetWithNames): DashboardWidgetDto {
  const def = widgetDefinition(row.type);
  let config: DashboardWidgetDto['config'];
  try {
    config = def.parseConfig(row.config);
  } catch {
    // Configs are written through this same parser, so a stored row only
    // fails when a LATER registry tightened the schema — a stored row
    // degrades (raw, for the editor to fix), never crashes the read (the
    // 6.1.2 stored-envelope precedent).
    config = row.config as unknown as DashboardWidgetDto['config'];
  }
  return {
    id: row.id,
    type: row.type,
    column: row.column,
    position: row.position,
    config,
    source: toSourceDto(row),
    rendererKind: def.rendererKind,
    editorKind: def.editorKind,
  };
}

export function toDashboardDetailDto(
  row: DashboardWithFacts,
  widgets: DashboardWidgetWithNames[],
  actorUserId: string,
): DashboardDetailDto {
  return {
    ...toDashboardSummaryDto(row, actorUserId),
    widgets: widgets.map(toDashboardWidgetDto),
  };
}
