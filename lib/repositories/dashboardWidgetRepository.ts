import { Prisma, type DashboardWidget } from '@prisma/client';
import { db } from '@/lib/db';
import type { DashboardWidgetWithNames } from '@/lib/mappers/dashboardMappers';

// Dashboard-widget data access (Story 6.3 · Subtask 6.3.1). Single Prisma
// ops; writes require `tx` (CLAUDE.md). Reads are bounded by construction —
// a dashboard holds ≤20 widgets (the service-enforced cap), so the
// by-dashboard list never needs paging.

/** The include that decorates a row with its referents' display names (the
 * DTO's source line — fetched in the same query, never N+1). */
const namesInclude = {
  savedFilter: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } },
} satisfies Prisma.DashboardWidgetInclude;

export const dashboardWidgetRepository = {
  /** One dashboard's widgets in render order (column, then fractional
   * position — the grid read). */
  async listByDashboard(
    dashboardId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DashboardWidgetWithNames[]> {
    if (!dashboardId) return [];
    const client = tx ?? db;
    return client.dashboardWidget.findMany({
      where: { dashboardId },
      include: namesInclude,
      orderBy: [{ column: 'asc' }, { position: 'asc' }, { id: 'asc' }],
    });
  },

  /** One widget, dashboard-scoped (a cross-dashboard id reads as null —
   * the service's 404). Validation read inside write transactions. */
  async findByIdWithNames(
    dashboardId: string,
    widgetId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DashboardWidgetWithNames | null> {
    if (!dashboardId || !widgetId) return null;
    const client = tx ?? db;
    return client.dashboardWidget.findFirst({
      where: { id: widgetId, dashboardId },
      include: namesInclude,
    });
  },

  /** The cap gate — a count that guards the add write (required `tx`). */
  async countByDashboard(dashboardId: string, tx: Prisma.TransactionClient): Promise<number> {
    if (!dashboardId) return 0;
    return tx.dashboardWidget.count({ where: { dashboardId } });
  },

  /** The 6.2.1 delete-dependents count — how many widgets a saved-filter
   * delete would STALE (SetNull, never cascade). Pure read. */
  async countBySavedFilter(savedFilterId: string, tx?: Prisma.TransactionClient): Promise<number> {
    if (!savedFilterId) return 0;
    const client = tx ?? db;
    return client.dashboardWidget.count({ where: { savedFilterId } });
  },

  async create(
    data: Prisma.DashboardWidgetUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DashboardWidget> {
    return tx.dashboardWidget.create({ data });
  },

  async update(
    id: string,
    data: Pick<
      Prisma.DashboardWidgetUncheckedUpdateInput,
      'config' | 'savedFilterId' | 'projectId' | 'column' | 'position'
    >,
    tx: Prisma.TransactionClient,
  ): Promise<DashboardWidget> {
    return tx.dashboardWidget.update({ where: { id }, data });
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<DashboardWidget> {
    return tx.dashboardWidget.delete({ where: { id } });
  },
};
