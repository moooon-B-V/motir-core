import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { backlogService } from '@/lib/services/backlogService';
import { isIssueType } from '@/lib/issues/parentRules';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  ReporterNotInWorkspaceError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { CrossProjectSprintAssignmentError, SprintNotFoundError } from '@/lib/sprints/errors';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import { parseIssueFilter } from '@/lib/issues/issueListFilter';
import { upgradeFacetsIntoAst } from '@/lib/issues/issueListAdvancedFilter';
import { decodeFilterParam } from '@/lib/filters/ast';
import { FilterValidationError } from '@/lib/filters/errors';

const MAX_TITLE_LENGTH = 200;

// GET /api/backlog (Subtask 4.1.4) — one bounded, cursor-paginated page of the
// ACTIVE project's backlog (issues with `sprintId IS NULL`) in rank order, plus
// the total count for the "N issues" header (finding #57 — never load-all). Thin
// HTTP layer over backlogService.getBacklog; session-required; the project +
// workspace come from the active-project context (NEVER the client). No db / no
// transaction here (CLAUDE.md).
//
// Active-project routing (NOT /api/projects/[id]/backlog, which the 4.1.4 card
// sketches): the app is single-active-project — `/api/board`, `/api/sprints`,
// and the `/boards` / `/issues` pages all resolve getActiveProject() and there
// is NO project-by-key route tree to mirror. The card's path-param shape loses
// to the shipped active-project pattern (decision ladder: rung 2 shipped code >
// rung 3 card prose). The 4.2 backlog UI binds here against the active project.
//
// Query: ?cursor=<last id> (omit for page 1) · ?limit=<1..100> (default 50).
//
// FILTER (Story 8.8 · Subtask 8.8.17): the backlog read takes the SAME filter
// params as `/issues` + the board — the quick facets `?kind` · `?type` ·
// `?status` · `?assignee` · `?q` and the advanced builder's `?filter=v1:` AST.
// They're parsed exactly as `/issues` (`parseIssueFilter`) + decoded
// (`decodeFilterParam`), then merged into ONE predicate via the board's lossless
// `upgradeFacetsIntoAst` AND-merge and threaded to the service, which resolves +
// validates it (an invalid field/operator/value → `FilterValidationError` → 422
// below). A malformed/forged advanced param decodes to facets-only (the
// forged-URL degrade the board route + the navigator use — the page never emits
// a bad param). `cursor` / `limit` are unchanged.
export async function GET(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const params = new URL(req.url).searchParams;
  const cursor = params.get('cursor')?.trim() || undefined;
  const limitRaw = params.get('limit')?.trim();
  // A non-numeric / out-of-range limit is clamped by the service (NaN → default),
  // not rejected — friendlier for a list fetch.
  const limit = limitRaw ? Number(limitRaw) : undefined;

  // Parse the quick facets + decode the advanced AST, then fold them into one
  // predicate (the board-page precedent). Empty selection → no AST → the
  // unfiltered read (byte-for-byte the 4.1.4 projection).
  const facets = parseIssueFilter({
    kind: params.getAll('kind'),
    type: params.getAll('type'),
    status: params.getAll('status'),
    assignee: params.getAll('assignee'),
    q: params.get('q') ?? undefined,
    filter: params.get('filter') ?? undefined,
  });
  const decoded = facets.advanced ? decodeFilterParam(facets.advanced) : null;
  const advancedAst = decoded && decoded.ok ? decoded.ast : null;
  const effectiveAst = upgradeFacetsIntoAst(facets, advancedAst);
  const filterAst = effectiveAst.conditions.length > 0 ? effectiveAst : undefined;

  try {
    const page = await backlogService.getBacklog(
      ctx.projectId,
      { cursor, limit, filterAst },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(page);
  } catch (err) {
    // A structurally-valid AST that fails registry validation (unknown
    // field/operator or a bad value) → typed 422, mirroring the board route.
    if (err instanceof FilterValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}

// POST /api/backlog (Subtask 4.2.2) — inline "+ Create issue" from the backlog
// or a sprint container. Thin HTTP layer over backlogService.createBacklogIssue;
// the project comes from the ACTIVE-project context (NEVER the client, mirroring
// GET above), the reporter is the session user (set by the service from ctx —
// never read from the body). When `sprintId` is in the body the issue is born
// directly in that sprint (same-project guarded); omitted → into the backlog.
// No db / no transaction here (CLAUDE.md).
//
// Body: { kind, title, sprintId?, descriptionMd?, priority?, assigneeId?, parentId? }
//
// Typed errors → status codes:
//   ProjectNotFoundError / SprintNotFoundError / WorkItemNotFoundError       → 404
//   ProjectAccessDeniedError                                                 → 403
//   IllegalParentTypeError / DepthLimitExceededError / CrossProjectParentError
//     / AssigneeNotInWorkspaceError / ReporterNotInWorkspaceError
//     / CrossProjectSprintAssignmentError                                    → 422
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (!isIssueType(b.kind)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`kind` must be a valid work item type.' },
      { status: 400 },
    );
  }
  if (typeof b.title !== 'string' || b.title.trim().length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`title` is required.' },
      { status: 400 },
    );
  }
  if (b.title.trim().length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: `\`title\` must be at most ${MAX_TITLE_LENGTH} characters.` },
      { status: 400 },
    );
  }
  for (const field of ['sprintId', 'parentId', 'assigneeId'] as const) {
    if (b[field] !== undefined && b[field] !== null && typeof b[field] !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: `\`${field}\` must be a string.` },
        { status: 400 },
      );
    }
  }

  try {
    const issue = await backlogService.createBacklogIssue(
      ctx.projectId,
      {
        kind: b.kind,
        title: b.title.trim(),
        descriptionMd: typeof b.descriptionMd === 'string' ? b.descriptionMd : null,
        ...(typeof b.priority === 'string' ? { priority: b.priority as WorkItemPriorityDto } : {}),
        assigneeId: typeof b.assigneeId === 'string' ? b.assigneeId : null,
        parentId: typeof b.parentId === 'string' ? b.parentId : null,
        sprintId: typeof b.sprintId === 'string' ? b.sprintId : null,
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(issue, { status: 201 });
  } catch (err) {
    if (
      err instanceof ProjectNotFoundError ||
      err instanceof SprintNotFoundError ||
      err instanceof WorkItemNotFoundError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (
      err instanceof IllegalParentTypeError ||
      err instanceof DepthLimitExceededError ||
      err instanceof CrossProjectParentError ||
      err instanceof AssigneeNotInWorkspaceError ||
      err instanceof ReporterNotInWorkspaceError ||
      err instanceof CrossProjectSprintAssignmentError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
