'use server';

import { getActiveProject } from '@/lib/projects';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { PlanSessionStateDto } from '@/lib/dto/planSessions';
import type { RoomView } from '@/lib/rooms/roomView';

import { buildSessionRowViews } from './sessionRowView';
import type { SessionRowView } from './_components/types';

// Server Action backing the Plans list's load-more-on-scroll (MOTIR-1338; the
// session list since MOTIR-6025). The page server-renders the FIRST page; this
// streams each later cursor page as the sentinel nears the viewport, building the
// SAME row view-models the page does, so a streamed page renders identically.
//
// Transport-only (a Server Action is the route-layer equivalent): resolve the
// active project, RE-GATE browse access — it can change mid-scroll — and call
// ONE service read. The client list never touches the service layer.
export async function loadMoreSessionsAction(
  cursor: string,
  planState: PlanSessionStateDto | null,
  view: RoomView,
): Promise<{ views: SessionRowView[]; nextCursor: string | null }> {
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
