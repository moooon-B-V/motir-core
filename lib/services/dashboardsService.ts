import type { DashboardAccess, DashboardLayout, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { dashboardRepository } from '@/lib/repositories/dashboardRepository';
import { dashboardWidgetRepository } from '@/lib/repositories/dashboardWidgetRepository';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  DASHBOARD_LIST_LIMIT,
  DASHBOARD_MAX_WIDGETS,
  DASHBOARD_NAME_MAX_LENGTH,
  LAYOUT_COLUMN_COUNT,
} from '@/lib/dashboards/constants';
import {
  DashboardForbiddenError,
  DashboardNotFoundError,
  DashboardWidgetCapError,
  DashboardWidgetNotFoundError,
  DashboardWidgetSourceNotFoundError,
  InvalidDashboardAccessError,
  InvalidDashboardLayoutError,
  InvalidDashboardNameError,
  InvalidDashboardWidgetMoveError,
  type DashboardAction,
} from '@/lib/dashboards/errors';
import {
  widgetDefinition,
  type WidgetConfig,
  type WidgetSourceDescriptor,
  type WidgetSourceInput,
} from '@/lib/dashboards/widgetRegistry';
import { keyBetween, keyForAppend } from '@/lib/workItems/positioning';
import {
  toDashboardDetailDto,
  toDashboardSummaryDto,
  toDashboardWidgetDto,
  type DashboardWithFacts,
} from '@/lib/mappers/dashboardMappers';
import type {
  DashboardDetailDto,
  DashboardSummaryDto,
  DashboardWidgetDto,
} from '@/lib/dto/dashboards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Dashboards service (Story 6.3 · Subtask 6.3.1) — the workspace-scoped
// widget-grid substrate. Owns validation (name caps, the access/layout
// enums, the widget registry gate), the permission rule, transactions, and
// DTO mapping. Routes are HTTP-only (CLAUDE.md).
//
// THE PERMISSION RULE (the recorded 6.3 deviation from Jira's audience
// matrix — viewer/editor lists are the documented extension):
//   * create        — any workspace member (the workspace gate is the ctx).
//   * see           — owner always; everyone in the workspace when
//                     `access = 'workspace'`. A private dashboard reads as
//                     DashboardNotFoundError for non-owners (finding #44 —
//                     "can't see" is indistinguishable from "doesn't
//                     exist"; the 404-shaped denial).
//   * mutate        — owner ONLY (rename / access / layout / delete and
//                     every widget write). Visible-but-not-owner is the
//                     typed 403.
//
// THE WIDGET GATE (mistake #29): every widget write flows through the TOTAL
// registry — unknown type / malformed config / broken source-XOR → typed
// 422. An INCOMING source referent must exist in this workspace (typed 422
// — a rejection); only a STORED referent degrades, to the stale state, via
// the schema's SetNull (the verified Cloud gadget behaviour).
//
// Every read-derived write locks the dashboard row FIRST
// (lock-before-read-derived-update): the cap check, the position
// computation, and the layout clamp all read state the write depends on,
// and the lock serializes concurrent editors (the 3.2 move precedent).

const ACCESS_VALUES: readonly DashboardAccess[] = ['private', 'workspace'];
const LAYOUT_VALUES: readonly DashboardLayout[] = ['one', 'two', 'three'];

function parseName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new InvalidDashboardNameError('Dashboard name must not be blank.');
  if (name.length > DASHBOARD_NAME_MAX_LENGTH) {
    throw new InvalidDashboardNameError(
      `Dashboard name must be at most ${DASHBOARD_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
}

function parseAccess(raw: string): DashboardAccess {
  if (!(ACCESS_VALUES as string[]).includes(raw)) throw new InvalidDashboardAccessError(raw);
  return raw as DashboardAccess;
}

function parseLayout(raw: string): DashboardLayout {
  if (!(LAYOUT_VALUES as string[]).includes(raw)) throw new InvalidDashboardLayoutError(raw);
  return raw as DashboardLayout;
}

/** The SEE gate: the row must exist in this workspace and sit inside the
 * actor's visibility — anything else is the 404 (finding #44). */
function assertVisible(
  row: DashboardWithFacts | null,
  ctx: ServiceContext,
  dashboardId: string,
): asserts row is DashboardWithFacts {
  if (!row || (row.access === 'private' && row.ownerId !== ctx.userId)) {
    throw new DashboardNotFoundError(dashboardId);
  }
}

/** The MUTATE gate: visible first (404 outranks 403 — no existence leak),
 * then owner-only (403). */
function assertOwner(
  row: DashboardWithFacts | null,
  ctx: ServiceContext,
  dashboardId: string,
  action: DashboardAction,
): asserts row is DashboardWithFacts {
  assertVisible(row, ctx, dashboardId);
  if (row.ownerId !== ctx.userId) throw new DashboardForbiddenError(action);
}

/** Resolve an INCOMING data source to FK columns, verifying the referent
 * exists in this workspace (typed 422 otherwise — never a cross-tenant
 * write). Runs inside the write tx: the referent read guards the write. */
async function resolveSourceColumns(
  descriptor: WidgetSourceDescriptor,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<{ savedFilterId: string | null; projectId: string | null }> {
  if (descriptor.kind === 'saved_filter') {
    const filter = await savedFilterRepository.findByIdWithStars(
      descriptor.savedFilterId,
      ctx.userId,
      tx,
    );
    if (!filter || filter.workspaceId !== ctx.workspaceId) {
      throw new DashboardWidgetSourceNotFoundError(
        `Saved filter ${descriptor.savedFilterId} was not found in this workspace.`,
      );
    }
    return { savedFilterId: filter.id, projectId: null };
  }
  if (descriptor.kind === 'project') {
    const project = await projectRepository.findById(descriptor.projectId, tx);
    if (!project || project.workspaceId !== ctx.workspaceId || project.archivedAt !== null) {
      throw new DashboardWidgetSourceNotFoundError(
        `Project ${descriptor.projectId} was not found in this workspace.`,
      );
    }
    return { savedFilterId: null, projectId: project.id };
  }
  // Unreachable: resolveDataSource never returns 'stale' for INCOMING input
  // (the XOR throws first) — classifyStoredSource alone mints it.
  throw new DashboardWidgetSourceNotFoundError('A widget data source referent is required.');
}

/** The last position in a column (null in an empty column) — the append
 * bound. Reads the ≤20 in-tx rows; bounded by the cap. */
async function lastPositionInColumn(
  dashboardId: string,
  column: number,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const widgets = await dashboardWidgetRepository.listByDashboard(dashboardId, tx);
  const inColumn = widgets.filter((w) => w.column === column);
  return inColumn.length > 0 ? inColumn[inColumn.length - 1]!.position : null;
}

export interface CreateDashboardInput {
  name: string;
  access?: string;
  layout?: string;
}

export interface UpdateDashboardInput {
  name?: string;
  access?: string;
  layout?: string;
}

export interface AddWidgetInput {
  type: string;
  savedFilterId?: string | null;
  projectId?: string | null;
  config?: unknown;
}

export interface UpdateWidgetInput {
  /** Replacement data source (both ids absent = keep the stored source). */
  savedFilterId?: string | null;
  projectId?: string | null;
  /** Replacement per-type settings (absent = keep the stored config). */
  config?: unknown;
}

export interface MoveWidgetInput {
  /** Target column (0-based, < the layout's column count). */
  column: number;
  /** The widget to land AFTER (same column; absent = column start). */
  afterId?: string | null;
  /** The widget to land BEFORE (same column; absent = column end). */
  beforeId?: string | null;
}

export const dashboardsService = {
  /** The bounded home/switcher list: mine + workspace-shared (private rows
   * of others never leave the predicate), name-ordered. */
  async listDashboards(ctx: ServiceContext): Promise<DashboardSummaryDto[]> {
    const rows = await dashboardRepository.listVisible(
      ctx.workspaceId,
      ctx.userId,
      DASHBOARD_LIST_LIMIT,
    );
    return rows.map((row) => toDashboardSummaryDto(row, ctx.userId));
  },

  /** One grid: the dashboard + its ≤20 widgets in render order, source
   * names decorated in the same read. Access-gated (private + not owner →
   * the 404-shaped denial). */
  async getDashboard(dashboardId: string, ctx: ServiceContext): Promise<DashboardDetailDto> {
    const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, dashboardId);
    assertVisible(row, ctx, dashboardId);
    const widgets = await dashboardWidgetRepository.listByDashboard(row.id);
    return toDashboardDetailDto(row, widgets, ctx.userId);
  },

  /** Create — any workspace member. Defaults: private, two columns. */
  async create(input: CreateDashboardInput, ctx: ServiceContext): Promise<DashboardSummaryDto> {
    const name = parseName(input.name);
    const access = input.access === undefined ? 'private' : parseAccess(input.access);
    const layout = input.layout === undefined ? 'two' : parseLayout(input.layout);
    return db.$transaction(async (tx) => {
      const created = await dashboardRepository.create(
        { workspaceId: ctx.workspaceId, ownerId: ctx.userId, name, access, layout },
        tx,
      );
      const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, created.id, tx);
      return toDashboardSummaryDto(row as DashboardWithFacts, ctx.userId);
    });
  },

  /**
   * Rename / access-change / relayout — owner-only, one transaction. A
   * layout SHRINK rehomes the orphaned columns' widgets into the new last
   * column (appended after its existing widgets, preserving their relative
   * order — the Jira edit-mode reflow), so `column` stays < the layout
   * count as an invariant.
   */
  async update(
    dashboardId: string,
    input: UpdateDashboardInput,
    ctx: ServiceContext,
  ): Promise<DashboardSummaryDto> {
    const name = input.name === undefined ? undefined : parseName(input.name);
    const access = input.access === undefined ? undefined : parseAccess(input.access);
    const layout = input.layout === undefined ? undefined : parseLayout(input.layout);
    const action: DashboardAction =
      name !== undefined ? 'rename' : access !== undefined ? 'change-access' : 'change-layout';
    return db.$transaction(async (tx) => {
      await dashboardRepository.lockById(ctx.workspaceId, dashboardId, tx);
      const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, dashboardId, tx);
      assertOwner(row, ctx, dashboardId, action);
      if (layout !== undefined && layout !== row.layout) {
        const newCount = LAYOUT_COLUMN_COUNT[layout];
        const widgets = await dashboardWidgetRepository.listByDashboard(row.id, tx);
        const lastColumn = newCount - 1;
        let tail = widgets.filter((w) => w.column === lastColumn).at(-1)?.position ?? null;
        // listByDashboard is (column, position)-ordered, so orphans arrive
        // in their on-grid order and append in it.
        for (const widget of widgets.filter((w) => w.column >= newCount)) {
          tail = keyForAppend(tail);
          await dashboardWidgetRepository.update(
            widget.id,
            { column: lastColumn, position: tail },
            tx,
          );
        }
      }
      await dashboardRepository.update(row.id, { name, access, layout }, tx);
      const updated = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, row.id, tx);
      return toDashboardSummaryDto(updated as DashboardWithFacts, ctx.userId);
    });
  },

  /** Delete — owner-only. Widgets die with the row (FK Cascade). */
  async delete(dashboardId: string, ctx: ServiceContext): Promise<void> {
    await db.$transaction(async (tx) => {
      await dashboardRepository.lockById(ctx.workspaceId, dashboardId, tx);
      const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, dashboardId, tx);
      assertOwner(row, ctx, dashboardId, 'delete');
      await dashboardRepository.delete(row.id, tx);
    });
  },

  /**
   * Add a widget — owner-only, registry-gated, cap-gated (the 21st add is
   * the typed 422 — the designed cap state). The new widget appends to the
   * end of column 0 (the 6.3.5 grid drags it into place; the add panel has
   * no column picker — the Jira add-gadget behaviour).
   */
  async addWidget(
    dashboardId: string,
    input: AddWidgetInput,
    ctx: ServiceContext,
  ): Promise<DashboardWidgetDto> {
    const def = widgetDefinition(input.type);
    const config: WidgetConfig = def.parseConfig(input.config);
    const descriptor = def.resolveDataSource(input as WidgetSourceInput);
    return db.$transaction(async (tx) => {
      await dashboardRepository.lockById(ctx.workspaceId, dashboardId, tx);
      const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, dashboardId, tx);
      assertOwner(row, ctx, dashboardId, 'edit-widgets');
      const count = await dashboardWidgetRepository.countByDashboard(row.id, tx);
      if (count >= DASHBOARD_MAX_WIDGETS) throw new DashboardWidgetCapError(DASHBOARD_MAX_WIDGETS);
      const sourceColumns = await resolveSourceColumns(descriptor, ctx, tx);
      const position = keyForAppend(await lastPositionInColumn(row.id, 0, tx));
      const created = await dashboardWidgetRepository.create(
        {
          dashboardId: row.id,
          type: def.type,
          column: 0,
          position,
          config: config as unknown as Prisma.InputJsonValue,
          ...sourceColumns,
        },
        tx,
      );
      const widget = await dashboardWidgetRepository.findByIdWithNames(row.id, created.id, tx);
      return toDashboardWidgetDto(widget!);
    });
  },

  /**
   * Reconfigure a widget — owner-only. `config` replaces the settings
   * (re-validated through the registry); a provided source id replaces the
   * source (re-validated + XOR'd — this is also how a STALE widget heals:
   * the reconfigure affordance posts a fresh referent). The type is
   * immutable (a Jira gadget never changes type — remove + add instead).
   */
  async updateWidget(
    dashboardId: string,
    widgetId: string,
    input: UpdateWidgetInput,
    ctx: ServiceContext,
  ): Promise<DashboardWidgetDto> {
    return db.$transaction(async (tx) => {
      await dashboardRepository.lockById(ctx.workspaceId, dashboardId, tx);
      const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, dashboardId, tx);
      assertOwner(row, ctx, dashboardId, 'edit-widgets');
      const widget = await dashboardWidgetRepository.findByIdWithNames(row.id, widgetId, tx);
      if (!widget) throw new DashboardWidgetNotFoundError(widgetId);
      const def = widgetDefinition(widget.type);
      const data: Parameters<typeof dashboardWidgetRepository.update>[1] = {};
      if (input.config !== undefined) {
        data.config = def.parseConfig(input.config) as unknown as Prisma.InputJsonValue;
      }
      if (input.savedFilterId != null || input.projectId != null) {
        const descriptor = def.resolveDataSource(input as WidgetSourceInput);
        Object.assign(data, await resolveSourceColumns(descriptor, ctx, tx));
      }
      await dashboardWidgetRepository.update(widget.id, data, tx);
      const updated = await dashboardWidgetRepository.findByIdWithNames(row.id, widget.id, tx);
      return toDashboardWidgetDto(updated!);
    });
  },

  /** Remove a widget — owner-only. */
  async removeWidget(dashboardId: string, widgetId: string, ctx: ServiceContext): Promise<void> {
    await db.$transaction(async (tx) => {
      await dashboardRepository.lockById(ctx.workspaceId, dashboardId, tx);
      const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, dashboardId, tx);
      assertOwner(row, ctx, dashboardId, 'edit-widgets');
      const widget = await dashboardWidgetRepository.findByIdWithNames(row.id, widgetId, tx);
      if (!widget) throw new DashboardWidgetNotFoundError(widgetId);
      await dashboardWidgetRepository.delete(widget.id, tx);
    });
  },

  /**
   * Move a widget — owner-only. The client names the target column and the
   * neighbour widget ids it dropped between; the SERVER computes the
   * fractional index (the board-move precedent — a client-minted position
   * could race a concurrent move; the dashboard lock + server mint
   * serialize instead). Neighbours must live on this dashboard in the
   * target column, in (after, before) order — anything else is a typed 422.
   */
  async moveWidget(
    dashboardId: string,
    widgetId: string,
    input: MoveWidgetInput,
    ctx: ServiceContext,
  ): Promise<DashboardWidgetDto> {
    return db.$transaction(async (tx) => {
      await dashboardRepository.lockById(ctx.workspaceId, dashboardId, tx);
      const row = await dashboardRepository.findByIdWithFacts(ctx.workspaceId, dashboardId, tx);
      assertOwner(row, ctx, dashboardId, 'edit-widgets');
      const widget = await dashboardWidgetRepository.findByIdWithNames(row.id, widgetId, tx);
      if (!widget) throw new DashboardWidgetNotFoundError(widgetId);

      const columnCount = LAYOUT_COLUMN_COUNT[row.layout];
      if (!Number.isInteger(input.column) || input.column < 0 || input.column >= columnCount) {
        throw new InvalidDashboardWidgetMoveError(
          `Target column ${input.column} is outside the "${row.layout}"-column layout.`,
        );
      }

      // Resolve the neighbour bounds within the (column, position)-ordered
      // sibling list, the MOVING widget excluded (dropping next to yourself
      // is a no-op bound, not an error).
      const siblings = (await dashboardWidgetRepository.listByDashboard(row.id, tx)).filter(
        (w) => w.column === input.column && w.id !== widget.id,
      );
      const findBound = (id: string | null | undefined, label: 'afterId' | 'beforeId') => {
        if (id == null) return null;
        const bound = siblings.find((w) => w.id === id);
        if (!bound) {
          throw new InvalidDashboardWidgetMoveError(
            `\`${label}\` ${id} is not a widget in the target column.`,
          );
        }
        return bound;
      };
      const after = findBound(input.afterId, 'afterId');
      const before = findBound(input.beforeId, 'beforeId');
      if (after && before && after.position >= before.position) {
        throw new InvalidDashboardWidgetMoveError(
          '`afterId` and `beforeId` do not bound a slot — they are out of order.',
        );
      }
      // Open bounds fall back to the column edges so a bare {column} append
      // and a bare {beforeId: first} prepend both mint valid keys.
      const prev = after?.position ?? (before ? null : (siblings.at(-1)?.position ?? null));
      const next = before?.position ?? null;
      const position = keyBetween(prev, next);

      await dashboardWidgetRepository.update(widget.id, { column: input.column, position }, tx);
      const moved = await dashboardWidgetRepository.findByIdWithNames(row.id, widget.id, tx);
      return toDashboardWidgetDto(moved!);
    });
  },
};
