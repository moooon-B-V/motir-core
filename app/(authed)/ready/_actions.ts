'use server';

import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ReadyItemDto } from '@/lib/dto/ready';

// Server Action backing the /ready page's cursor-driven "load more on scroll"
// (Subtask 7.0.6). The page server-renders the FIRST ready page; this fetches
// each subsequent cursor page on demand as the virtualized list nears its end,
// so both the initial payload AND the DOM stay bounded (finding #57 — never a
// "load all rows" read). It reuses `workItemsService.listReady` — the SAME
// predicate + `(type asc, priority desc, key asc)` sort the page and `POST /api/ready/next`
// use — so every page agrees on what's ready and in what order.
//
// Transport-only (CLAUDE.md: a Server Action is a route-layer equivalent): it
// resolves the active-project context and calls ONE service method. No `db.*`,
// no `$transaction`. The HTTP `GET /api/ready` endpoint (Subtask 7.0.4) is the
// OTHER consumers' contract (the BYOK CLI / external agents); the page reads the
// service directly, the established Server-Component/Action path — no double
// HTTP hop for our own UI.
export async function loadMoreReadyAction(
  cursor: string,
): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }> {
  const ctx = await getActiveProject();
  // No active project (signed out mid-scroll, or the project vanished) → nothing
  // more to stream; the list simply stops paging.
  if (!ctx) return { items: [], nextCursor: null };
  return workItemsService.listReady(
    ctx.projectId,
    { cursor },
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );
}
