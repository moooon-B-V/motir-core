import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { sprintsService } from '@/lib/services/sprintsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  InvalidSprintNameError,
  NotSprintAdminError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';

// /api/sprints (Subtask 4.1.3) — create a sprint on the ACTIVE project. Thin
// HTTP layer over sprintsService; session-required; the project + workspace come
// from the active-project context (NEVER the client), like /api/boards. No db /
// no transaction here (CLAUDE.md). The rich sprint-planning surface (list +
// backlog) is Story 4.2; this is the minimal CRUD seam.

// GET /api/sprints (Subtask 4.2.3) — the ACTIVE project's sprints in `sequence`
// order, each with its committed-issue count, for the sprint-planning view. Thin
// HTTP layer over sprintsService.listByProject; session-required; project +
// workspace from the active-project context (NEVER the client). Exposes the
// already-shipped `sprintRepository.listByProject` leaf (Story 4.1) the backlog
// UI binds to. Available to any project member (a read, not owner-gated).
export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const sprints = await sprintsService.listByProject(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return NextResponse.json({ sprints });
}

// POST /api/sprints — create a PLANNED sprint on the active project. Body:
// { name?, goal?, startDate?, endDate? } (name defaults to "Sprint N"; dates are
// ISO-8601 strings). Returns 201 with the new sprint's DTO.
//
// Typed errors → status codes:
//   InvalidSprintNameError   → 400
//   NotSprintAdminError      → 403 (not owner, #36; TODO(6.4))
//   ProjectNotFoundError     → 404
//   SprintWindowInvalidError → 422
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

  const { name, goal, startDate, endDate } = (body ?? {}) as Record<string, unknown>;
  if (name !== undefined && typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` must be a string.' },
      { status: 400 },
    );
  }
  if (goal !== undefined && goal !== null && typeof goal !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`goal` must be a string or null.' },
      { status: 400 },
    );
  }
  if (startDate !== undefined && startDate !== null && typeof startDate !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`startDate` must be an ISO date string or null.' },
      { status: 400 },
    );
  }
  if (endDate !== undefined && endDate !== null && typeof endDate !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`endDate` must be an ISO date string or null.' },
      { status: 400 },
    );
  }

  try {
    const sprint = await sprintsService.createSprint(
      ctx.projectId,
      { name, goal, startDate, endDate },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(sprint, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidSprintNameError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof NotSprintAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof SprintWindowInvalidError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
