import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { sprintsService } from '@/lib/services/sprintsService';
import {
  InvalidSprintNameError,
  InvalidSprintTransitionError,
  NotSprintAdminError,
  SprintAlreadyActiveError,
  SprintNotFoundError,
  SprintNotStartableError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';

// POST /api/sprints/[id]/start (Subtask 4.4.2) — start a planned sprint:
//   { name?, startDate?, endDate? } → startSprint
// Thin HTTP layer over sprintsService; session-required; workspace from the
// active-project context (NEVER the client). The sprint id is the path param;
// the service tenant-gates it by workspace (a sprint outside the active
// workspace is a 404). No db / no transaction here (CLAUDE.md).
//
// Typed errors → status codes:
//   InvalidSprintNameError       → 400
//   NotSprintAdminError          → 403
//   SprintNotFoundError          → 404
//   SprintAlreadyActiveError     → 409
//   InvalidSprintTransitionError → 409
//   SprintNotStartableError      → 422
//   SprintWindowInvalidError     → 422
export async function POST(
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

  // The body is optional (start with defaults); tolerate an empty/absent body.
  let body: unknown = {};
  const raw = await req.text();
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
        { status: 400 },
      );
    }
  }

  const { name, startDate, endDate } = (body ?? {}) as Record<string, unknown>;
  if (name !== undefined && typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` must be a string.' },
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
    const sprint = await sprintsService.startSprint(
      id,
      { name, startDate, endDate },
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
    if (err instanceof SprintAlreadyActiveError || err instanceof InvalidSprintTransitionError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof SprintNotStartableError || err instanceof SprintWindowInvalidError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
