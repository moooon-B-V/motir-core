'use server';

import { getActiveProject } from '@/lib/projects';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { resolveActionReadActor } from '@/lib/visitor/readActor';
import type { PlanSessionStateDto } from '@/lib/dto/planSessions';
import type { RoomView } from '@/lib/rooms/roomView';

import { buildSessionRowViews } from './sessionRowView';
import type { SessionRowView } from './_components/types';

/** One streamed page, or the Visitor's spent read budget (MOTIR-6890). */
export type LoadMoreSessionsResult =
  | { views: SessionRowView[]; nextCursor: string | null }
  | { ok: false; error: 'rate_limited' };

// Server Action backing the Plans list's load-more-on-scroll (MOTIR-1338; the
// session list since MOTIR-6025). The page server-renders the FIRST page; this
// streams each later cursor page as the sentinel nears the viewport, building the
// SAME row view-models the page does, so a streamed page renders identically.
//
// Transport-only (a Server Action is the route-layer equivalent): resolve the
// reader, RE-GATE browse access — it can change mid-scroll — and call ONE service
// read. The client list never touches the service layer.
//
// A VISITOR's list (MOTIR-6890): `/p/<identifier>/plans` renders this same list,
// and its cursor was minted in the PUBLIC project the Visitor tab's address
// (`x-motir-visitor`, MOTIR-6892) names — never the reader's own active project.
// So the reader is resolved first, exactly as the tree's level actions do
// (`items/actions.ts`, MOTIR-6647): a Visitor reads that project through the
// Visitor read context page one used, in the Project view alone (the Mine tab is
// never offered to one, MOTIR-6645).
export async function loadMoreSessionsAction(
  cursor: string,
  planState: PlanSessionStateDto | null,
  view: RoomView,
): Promise<LoadMoreSessionsResult> {
  const actor = await resolveActionReadActor();
  if (actor.kind === 'limited') return { ok: false, error: 'rate_limited' };
  if (actor.kind === 'visitor') {
    const page = await planSessionsService.listSessions(actor.ctx.project.id, actor.ctx, {
      cursor,
      planState,
      view: 'project',
    });
    return { views: await buildSessionRowViews(page.sessions), nextCursor: page.nextCursor };
  }

  const ctx = await getActiveProject();
  // Signed out mid-scroll, or the project vanished → nothing more to stream.
  if (!ctx) return { views: [], nextCursor: null };

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const caps = await projectAccessService.getCapabilities(ctx.projectId, wsCtx);
  if (!caps.canBrowse) return { views: [], nextCursor: null };

  // The FILTER and the VIEW (MOTIR-6334) travel with the cursor: a cursor is only
  // meaningful within the predicate that produced it. The service still decides
  // what the view may show.
  const page = await planSessionsService.listSessions(ctx.projectId, wsCtx, {
    cursor,
    planState,
    view,
  });
  return { views: await buildSessionRowViews(page.sessions), nextCursor: page.nextCursor };
}
