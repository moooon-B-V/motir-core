import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { sprintsService } from '@/lib/services/sprintsService';
import {
  InvalidCarryOverTargetError,
  InvalidSprintTransitionError,
  NotSprintAdminError,
  SprintNotCompletableError,
  SprintNotFoundError,
} from '@/lib/sprints/errors';
import type { CarryOverDestination } from '@/lib/dto/sprints';

// POST /api/sprints/[id]/complete (Subtask 4.4.3) — complete an active sprint:
//   { carryOverTo?: 'backlog' | { sprintId: string } } → completeSprint
// Thin HTTP layer over sprintsService; session-required; workspace from the
// active-project context (NEVER the client). The sprint id is the path param;
// the service tenant-gates it by workspace (a sprint outside the active
// workspace is a 404). No db / no transaction here (CLAUDE.md).
//
// Typed errors → status codes:
//   NotSprintAdminError          → 403
//   SprintNotFoundError          → 404
//   InvalidSprintTransitionError → 409
//   SprintNotCompletableError    → 422
//   InvalidCarryOverTargetError  → 422
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

  // The body is optional (default carry-over to the backlog); tolerate an
  // empty/absent body.
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

  const { carryOverTo: rawCarryOverTo } = (body ?? {}) as Record<string, unknown>;
  const carryOverTo = parseCarryOverTo(rawCarryOverTo);
  if (carryOverTo === INVALID) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: "`carryOverTo` must be 'backlog' or { sprintId: string }.",
      },
      { status: 400 },
    );
  }

  try {
    const sprint = await sprintsService.completeSprint(
      id,
      { carryOverTo },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(sprint);
  } catch (err) {
    if (err instanceof NotSprintAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidSprintTransitionError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof SprintNotCompletableError || err instanceof InvalidCarryOverTargetError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** Sentinel for a malformed `carryOverTo` (distinct from a valid `undefined`). */
const INVALID = Symbol('invalid-carry-over');

/**
 * Validate the optional `carryOverTo` body field into a `CarryOverDestination`
 * (or `undefined` when absent — the service defaults it to the backlog).
 * Returns the `INVALID` sentinel for any malformed shape so the route can 400.
 */
function parseCarryOverTo(value: unknown): CarryOverDestination | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  if (value === 'backlog') return 'backlog';
  if (
    typeof value === 'object' &&
    'sprintId' in value &&
    typeof (value as { sprintId: unknown }).sprintId === 'string'
  ) {
    return { sprintId: (value as { sprintId: string }).sprintId };
  }
  return INVALID;
}
