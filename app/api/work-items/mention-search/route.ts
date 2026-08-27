import { NextResponse } from 'next/server';
import { workItemsService } from '@/lib/services/workItemsService';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/mention-search?q=<text> (Story 5.8 · Subtask 5.8.4) — the
// candidate read behind the `@`-mention picker in the rich-text editor. A thin
// HTTP layer over the SHARED `workItemsService.quickSearch` (the same key+title
// pg_trgm, workspace + Story-6.4-browsable-project scoped, bounded read the
// link/blocker pickers already ride): it reads the active-workspace context,
// runs the search capped at MENTION_SEARCH_LIMIT, and returns the matching
// `WorkItemSummaryDto` rows.
//
// No `db` / no `$transaction` / no business logic here (CLAUDE.md 4-layer rule).
// The service already short-circuits a short/empty/whitespace query to `[]` with
// NO DB round-trip (the MIN_QUERY_LENGTH guard) and enforces the browsable-project
// permission scope — this route re-implements neither. The only failure mode is
// 401 (no session / no resolvable workspace); a too-short query is a normal empty
// `[]`, never an error.

// The mention dropdown shows a small, fixed list — a tighter cap than the link
// picker's default page.
const MENTION_SEARCH_LIMIT = 8;

export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const q = new URL(req.url).searchParams.get('q') ?? '';
  const results = await workItemsService.quickSearch(q, ctx, { limit: MENTION_SEARCH_LIMIT });
  return NextResponse.json(results);
}
