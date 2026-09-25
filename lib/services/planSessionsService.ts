import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { Prisma } from '@/generated/prisma/client';
import { holdsRecordView, projectAccessService } from '@/lib/services/projectAccessService';
import {
  planChangeSessionRepository,
  type PlanSessionMineScope,
} from '@/lib/repositories/planChangeSessionRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { toPlanSessionRowDto } from '@/lib/mappers/planSessionMappers';
import { InvalidPlanSessionCursorError } from '@/lib/planChange/errors';
import {
  PLAN_SESSION_STATE_VALUES,
  type PlanSessionListPageDto,
  type PlanSessionRowDto,
  type PlanSessionStateCountsDto,
  type PlanSessionStateDto,
  type PlanSessionView,
} from '@/lib/dto/planSessions';

// The Plans page's SESSION list (MOTIR-6025, `agent-authored-plans.md`
// AMENDMENT 17 §8). Browse is the FLOOR; WHICH sessions a reader sees is a
// SCOPE the service resolves (Story MOTIR-6179 · MOTIR-6330), mirroring the
// Approvals room's `approvalGatesService.listRecords`:
//
//   * `project` — every session, for a reader holding `plan:view_any` (and, on a
//     bearer token, a grant that holds it — `holdsRecordView`);
//   * `mine` — the sessions the reader started, or that hold a plan they asked
//     for, decided, or have routed to them. Always served to a browser.
//
// ⚠️ A CALLER ONLY ASKS. The service decides from `getPermissions` — a
// PERMISSION read, never a role check, so a custom role can hold or withhold the
// room — and returns what it SERVED. A `project` request from a reader without
// the key is served `mine`, never refused: the page draws from that fact.

// Ten rows a page — the number the Plans surface is drawn to, and the one
// `plansService.listPlans` pages by (MOTIR-3235).
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)));
}

/** The cursor: the last row's `(lastActivityAt, id)`, base64url. */
function encodeCursor(row: PlanSessionRowDto): string {
  return Buffer.from(`${row.lastActivityAt}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | null | undefined,
): { lastActivityAt: Date; id: string } | null {
  if (cursor == null || cursor === '') return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = raw.indexOf('|');
  const lastActivityAt = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (bar <= 0 || !id || Number.isNaN(lastActivityAt.getTime())) {
    throw new InvalidPlanSessionCursorError();
  }
  return { lastActivityAt, id };
}

/**
 * Resolve the scope a read SERVES, and — for `mine` — the reader's routed plan
 * ids, in ONE place for all three reads. Called inside the read's transaction.
 * An omitted `view` asks for `project`, which is what every reader saw before
 * the scope existed.
 */
async function resolveScope(
  projectId: string,
  ctx: ServiceContext,
  requested: PlanSessionView | undefined,
  tx: Prisma.TransactionClient,
): Promise<{ scope: PlanSessionView; mine: PlanSessionMineScope | null }> {
  const held = await projectAccessService.getPermissions(projectId, ctx, tx);
  const fullView = holdsRecordView(held, ctx, 'plan:view_any');
  if ((requested ?? 'project') === 'project' && fullView) return { scope: 'project', mine: null };
  const routedPlanIds = await approvalGateRepository.findAwaitingRoutedPlanIds(
    { projectIds: [projectId], userId: ctx.userId },
    tx,
  );
  return { scope: 'mine', mine: { userId: ctx.userId, routedPlanIds } };
}

export interface ListSessionsOptions {
  /** The scope the caller ASKS for; the service decides what it serves. */
  view?: PlanSessionView;
  /** Narrow to one plan state; omitted = every session. */
  planState?: PlanSessionStateDto | null;
  cursor?: string | null;
  limit?: number;
}

export const planSessionsService = {
  /**
   * A page of the project's sessions, newest activity first, cursor-paged on
   * `(lastActivityAt desc, id desc)`. ONE statement per page — the repository
   * joins each session's first turn, latest plan, plan count and starter.
   */
  async listSessions(
    projectId: string,
    ctx: ServiceContext,
    opts: ListSessionsOptions = {},
  ): Promise<PlanSessionListPageDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const limit = clampLimit(opts.limit);
    const after = decodeCursor(opts.cursor);
    const { rows, scope } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const resolved = await resolveScope(projectId, ctx, opts.view, tx);
      const page = await planChangeSessionRepository.listPageByProject(
        {
          projectId,
          workspaceId: ctx.workspaceId,
          limit: limit + 1,
          after,
          state: opts.planState ?? null,
          mine: resolved.mine,
        },
        tx,
      );
      return { rows: page, scope: resolved.scope };
    });
    const hasMore = rows.length > limit;
    const sessions = (hasMore ? rows.slice(0, limit) : rows).map(toPlanSessionRowDto);
    return {
      sessions,
      nextCursor: hasMore ? encodeCursor(sessions[sessions.length - 1]!) : null,
      scope,
    };
  },

  /**
   * ONE session's row, or null when the id names no session of this project —
   * the `?session=<id>` landing, for a session that is not on the first page.
   */
  async getSessionRow(
    projectId: string,
    sessionId: string,
    ctx: ServiceContext,
    opts: { view?: PlanSessionView } = {},
  ): Promise<PlanSessionRowDto | null> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    // A session outside the served scope is null — the SAME answer as an id that
    // names no session, so a `?session=` link confirms nothing it may not show.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const { mine } = await resolveScope(projectId, ctx, opts.view, tx);
      return planChangeSessionRepository.listPageByProject(
        {
          projectId,
          workspaceId: ctx.workspaceId,
          limit: 1,
          after: null,
          state: null,
          sessionId,
          mine,
        },
        tx,
      );
    });
    return rows[0] ? toPlanSessionRowDto(rows[0]) : null;
  },

  /**
   * Whether ONE session is in the reader's served scope (MOTIR-6330) — the
   * overlay's by-id read and any other door that opens a session for a READER.
   * The same `resolveScope` + `mineFilter` the list uses, so a session a reader
   * can open by id is exactly one the list could have shown them.
   */
  async isSessionInReaderScope(
    projectId: string,
    sessionId: string,
    ctx: ServiceContext,
  ): Promise<boolean> {
    return (await this.getSessionRow(projectId, sessionId, ctx)) !== null;
  },

  /**
   * How many sessions hold each plan state — zero-filled over the whole
   * vocabulary, `none` included, so a filter with no rows reads `0`.
   */
  async countSessionsByPlanState(
    projectId: string,
    ctx: ServiceContext,
    opts: { view?: PlanSessionView } = {},
  ): Promise<PlanSessionStateCountsDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    // Counted over the SERVED scope, so the filter's numbers are the list's.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const { mine } = await resolveScope(projectId, ctx, opts.view, tx);
      return planChangeSessionRepository.countByLatestPlanState(
        projectId,
        ctx.workspaceId,
        tx,
        mine,
      );
    });
    const counts = Object.fromEntries(
      PLAN_SESSION_STATE_VALUES.map((state) => [state, 0]),
    ) as PlanSessionStateCountsDto;
    for (const row of rows) counts[row.state as PlanSessionStateDto] = row.count;
    return counts;
  },
};
