import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { backlogService } from '@/lib/services/backlogService';
import { SprintNotFoundError } from '@/lib/sprints/errors';
import { parseIssueFilter } from '@/lib/issues/issueListFilter';
import { upgradeFacetsIntoAst } from '@/lib/issues/issueListAdvancedFilter';
import { decodeFilterParam } from '@/lib/filters/ast';
import { FilterValidationError } from '@/lib/filters/errors';

// GET /api/sprints/[id]/issues (Subtask 4.1.4) — a sprint's ranked issues as a
// bounded, cursor-paginated page + the committed-issue count (finding #57). Thin
// HTTP layer over backlogService.getSprintIssues; session-required; the sprint
// id is the path param (the sprint names its own project, so the workspace from
// the session context is the only gate needed — the service tenant-gates the
// sprint by workspace, a foreign / unknown sprint → 404). No db / no transaction
// here (CLAUDE.md). The 4.2 sprint-planning view binds here.
//
// Query: ?cursor=<last id> (omit for page 1) · ?limit=<1..100> (default 50).
//
// FILTER (Story 8.8 · Subtask 8.8.20): the sprint read takes the SAME filter
// params as `/api/backlog` + `/items` + the board — the quick facets `?kind` ·
// `?type` · `?status` · `?assignee` · `?q` and the advanced builder's `?filter=v1:`
// AST — so a filtered backlog re-projects its sprint containers too (the 8.8.16
// design). Parsed exactly as `/api/backlog` (`parseIssueFilter`) + decoded
// (`decodeFilterParam`), then merged into ONE predicate via the board's lossless
// `upgradeFacetsIntoAst` AND-merge and threaded to the service, which resolves +
// validates it. A malformed/forged advanced param decodes to facets-only (the
// page never emits a bad param). `cursor` / `limit` are unchanged.
//
// Typed errors → status codes:
//   SprintNotFoundError → 404 · FilterValidationError → 422
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  const search = new URL(req.url).searchParams;
  const cursor = search.get('cursor')?.trim() || undefined;
  const limitRaw = search.get('limit')?.trim();
  const limit = limitRaw ? Number(limitRaw) : undefined;

  // Parse the quick facets + decode the advanced AST, then fold them into one
  // predicate (the /api/backlog precedent). Empty selection → no AST → the
  // unfiltered read (byte-for-byte the 4.1.4 projection).
  const facets = parseIssueFilter({
    kind: search.getAll('kind'),
    type: search.getAll('type'),
    status: search.getAll('status'),
    assignee: search.getAll('assignee'),
    q: search.get('q') ?? undefined,
    filter: search.get('filter') ?? undefined,
  });
  const decoded = facets.advanced ? decodeFilterParam(facets.advanced) : null;
  const advancedAst = decoded && decoded.ok ? decoded.ast : null;
  const effectiveAst = upgradeFacetsIntoAst(facets, advancedAst);
  const filterAst = effectiveAst.conditions.length > 0 ? effectiveAst : undefined;

  try {
    const page = await backlogService.getSprintIssues(id, { cursor, limit, filterAst }, ctx);
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    // A structurally-valid AST that fails registry validation (unknown
    // field/operator or a bad value) → typed 422, mirroring the backlog route.
    if (err instanceof FilterValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
