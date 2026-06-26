'use server';

import { getActiveProject } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { projectAccessService } from '@/lib/services/projectAccessService';

import { buildPlanRowViews } from './planRowView';
import type { PlanRowView } from './_components/types';

// Server Action backing the Plans list's cursor-driven "load more on scroll"
// (Subtask 7.21.1 / MOTIR-1338). The page server-renders the FIRST page; this
// streams each subsequent cursor page as the virtualized list nears its end, so
// neither the initial payload nor the DOM grows with the plan history (finding
// #57 — never a "load all" read). It builds the SAME row view-models the page
// does (`buildPlanRowViews`), so a streamed page renders identically.
//
// Transport-only (CLAUDE.md: a Server Action is the route-layer equivalent): it
// resolves the active-project context, re-gates browse access (which can change
// mid-scroll), and calls ONE service read. No `db.*`, no `$transaction`. This is
// the established Server-Component/Action path — the client list never touches
// the service layer directly.
export async function loadMorePlansAction(
  cursor: string,
): Promise<{ views: PlanRowView[]; nextCursor: string | null }> {
  const ctx = await getActiveProject();
  // Signed out mid-scroll, or the project vanished → nothing more to stream.
  if (!ctx) return { views: [], nextCursor: null };

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const caps = await projectAccessService.getCapabilities(ctx.projectId, wsCtx);
  if (!caps.canBrowse) return { views: [], nextCursor: null };

  const page = await plansService.listPlans(ctx.projectId, wsCtx, { cursor });
  const views = await buildPlanRowViews(page.plans, wsCtx);
  return { views, nextCursor: page.nextCursor };
}
