import { NextResponse } from 'next/server';

import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
} from '@/lib/planChange/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';

// Shared typed-error → HTTP mapping for the plan-change conversation routes
// (Story 7.30 · MOTIR-1728). Returns null for an unrecognized error so the route
// can rethrow (a 500). Kept out of the route files so open / append / submit map
// identically.
export function mapPlanChangeError(err: unknown): NextResponse | null {
  if (err instanceof PlanChangeSessionNotFoundError) {
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
