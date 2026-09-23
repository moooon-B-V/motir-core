import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { toPlanSessionRowDto } from '@/lib/mappers/planSessionMappers';
import { InvalidPlanSessionCursorError } from '@/lib/planChange/errors';
import {
  PLAN_SESSION_STATE_VALUES,
  type PlanSessionListPageDto,
  type PlanSessionRowDto,
  type PlanSessionStateCountsDto,
  type PlanSessionStateDto,
} from '@/lib/dto/planSessions';

// The Plans page's SESSION list (MOTIR-6025, `agent-authored-plans.md`
// AMENDMENT 17 §8). Browse-gated like `plansService.listPlans`: the list is a
// read of the project's planning work, so every member who can browse the
// project sees every session — reopening one read-only is the overlay's call.

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

export interface ListSessionsOptions {
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
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planChangeSessionRepository.listPageByProject(
        {
          projectId,
          workspaceId: ctx.workspaceId,
          limit: limit + 1,
          after,
          state: opts.planState ?? null,
        },
        tx,
      ),
    );
    const hasMore = rows.length > limit;
    const sessions = (hasMore ? rows.slice(0, limit) : rows).map(toPlanSessionRowDto);
    return {
      sessions,
      nextCursor: hasMore ? encodeCursor(sessions[sessions.length - 1]!) : null,
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
  ): Promise<PlanSessionRowDto | null> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planChangeSessionRepository.listPageByProject(
        { projectId, workspaceId: ctx.workspaceId, limit: 1, after: null, state: null, sessionId },
        tx,
      ),
    );
    return rows[0] ? toPlanSessionRowDto(rows[0]) : null;
  },

  /**
   * How many sessions hold each plan state — zero-filled over the whole
   * vocabulary, `none` included, so a filter with no rows reads `0`.
   */
  async countSessionsByPlanState(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<PlanSessionStateCountsDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planChangeSessionRepository.countByLatestPlanState(projectId, ctx.workspaceId, tx),
    );
    const counts = Object.fromEntries(
      PLAN_SESSION_STATE_VALUES.map((state) => [state, 0]),
    ) as PlanSessionStateCountsDto;
    for (const row of rows) counts[row.state as PlanSessionStateDto] = row.count;
    return counts;
  },
};
