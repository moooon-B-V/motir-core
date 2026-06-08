import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { sprintsService } from '@/lib/services/sprintsService';
import {
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  InvalidSprintNameError,
  NotSprintAdminError,
  SprintNotFoundError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';

// /api/sprints/[id] (Subtask 4.1.3) — per-sprint mutations:
//   PATCH  { name?, goal?, startDate?, endDate? } → updateSprint
//   DELETE                                        → deleteSprint
// Thin HTTP layer over sprintsService; session-required; workspace from the
// active-project context (NEVER the client). The sprint id is the path param;
// the service tenant-gates it by workspace (a sprint outside the active
// workspace is a 404). No db / no transaction here (CLAUDE.md).

// PATCH /api/sprints/[id] — edit a sprint's name / goal / window. An omitted
// field is unchanged; an explicit null clears goal / a date.
//
// Typed errors → status codes:
//   InvalidSprintNameError           → 400
//   NotSprintAdminError              → 403
//   SprintNotFoundError              → 404
//   CannotModifyCompletedSprintError → 409
//   SprintWindowInvalidError         → 422
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const { id } = await params;

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
    const sprint = await sprintsService.updateSprint(
      id,
      { name, goal, startDate, endDate },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(sprint);
  } catch (err) {
    if (err instanceof InvalidSprintNameError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof NotSprintAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof CannotModifyCompletedSprintError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof SprintWindowInvalidError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}

// DELETE /api/sprints/[id] — delete a planned/complete sprint (its issues fall
// back to the backlog via the SetNull FK). Returns 204 on success.
//
// Typed errors → status codes:
//   NotSprintAdminError           → 403
//   SprintNotFoundError           → 404
//   CannotDeleteActiveSprintError → 409
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const { id } = await params;

  try {
    await sprintsService.deleteSprint(id, { userId: ctx.userId, workspaceId: ctx.workspaceId });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotSprintAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof CannotDeleteActiveSprintError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    throw err;
  }
}
