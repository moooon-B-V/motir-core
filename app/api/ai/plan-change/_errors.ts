import { NextResponse } from 'next/server';

import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  PlanChangeJobNotRunningError,
  PlanChangeMailboxJobMismatchError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
  PlanChangeTurnNotFoundError,
  PlanTargetLockedError,
} from '@/lib/planChange/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';

// Shared typed-error → HTTP mapping for the plan-change conversation routes
// (Story 7.30 · MOTIR-1728). Returns null for an unrecognized error so the route
// can rethrow (a 500). Kept out of the route files so open / append / submit map
// identically.
export function mapPlanChangeError(err: unknown): NextResponse | null {
  // A mailbox turn addressed at a job this thread is not on joins the 404s
  // (MOTIR-4067): from the caller's side that job simply is not on their
  // conversation, and telling "no such thread" apart from "not that run" would
  // answer a question about somebody else's job.
  if (
    err instanceof PlanChangeSessionNotFoundError ||
    err instanceof PlanChangeTurnNotFoundError ||
    err instanceof PlanChangeMailboxJobMismatchError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof EmptyPlanChangeTurnError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  // A lost append race and a submit with nothing to send are both conflicts with
  // the thread's current state, not malformed requests.
  if (err instanceof PlanChangeTurnConflictError || err instanceof EmptyPlanChangeIntentError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  // A mailbox turn addressed at a job that has already finished (MOTIR-4067).
  // 409 for the same reason as the two above — a state conflict, not a malformed
  // request — and it CARRIES THE STATUS, because "that run is over" leaves the
  // client guessing whether to resubmit as a new turn (succeeded / stopped) or to
  // surface a failure, and those are opposite next steps.
  if (err instanceof PlanChangeJobNotRunningError) {
    return NextResponse.json(
      { code: err.code, error: err.message, jobStatus: err.status },
      { status: 409 },
    );
  }
  // Another session holds one of the scope's targets (MOTIR-2787). 409, not 403:
  // the caller MAY plan this item, it is simply taken — and the body names which
  // item, who has it, and when the lease runs out, so the client can say something
  // more useful than "try again".
  if (err instanceof PlanTargetLockedError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        target: err.targetIdentifier,
        holder: err.holderName,
        expiresAt: err.expiresAt.toISOString(),
      },
      { status: 409 },
    );
  }
  // A project that does not resolve IN THIS WORKSPACE — the cross-tenant posture
  // is 404, never 403 (no existence leak, finding #26). Unreachable over HTTP,
  // where the context comes from the actor's own active project, but the access
  // gate can raise it and it must not become a 500.
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message },
      { status: err.kind === 'browse' ? 404 : 403 },
    );
  }
  // MOTIR-2355 — the `ai:plan` refusal, carrying the key. A NON-browser never
  // produces it (the 404 above catches them first), so this is precisely "you are
  // on this project and may not spend its AI credits".
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  // The submit path drives the METERED motir-ai job — the same credit / transport
  // mapping the shipped augment route uses.
  if (err instanceof MotirAiOutOfCreditsError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
  }
  if (err instanceof MotirAiError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  return null;
}

/** The shared "no active project" 404 — the plan-change routes act on the actor's
 *  ACTIVE project (the shipped `/api/ai/augment` shape), so all three need it. */
export function noActiveProject(): NextResponse {
  return NextResponse.json(
    { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
    { status: 404 },
  );
}
