import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/internal/ai/terminal-statuses (MOTIR-4158) — the ai→core read-back
// that answers WHICH STATUSES MEAN FINISHED on the token's project: the set of
// status keys whose category is `done`.
//
// The narrowest read on this boundary — no subtree, no closure, no plan state —
// which is why the auth and tenancy work here is mirroring rather than design.
// Service-to-service ONLY (the §4a service bearer + §4b job token, both via
// `authenticateAndLimitJobRequest`); never a cookie session, never CORS-exposed.
// Thin transport per CLAUDE.md: authenticate, ONE service call, map typed errors.
//
// The project is the TOKEN's project — there is no caller-supplied project, so a
// token can only ever read its own workflow.
//
// ⚠️ WHY IT CROSSES THE WIRE AT ALL. `workflowsService.getTerminalStatusKeys`
// derives *terminal* from `category = 'done'`, so it covers `done` AND
// `cancelled` AND anything a customer configures; `motir-ai` had no way to reach
// it and was answering the question with a literal. Serving it from the same
// service `lib/plans/validateProposals.ts` step 4 already uses is what keeps the
// persistence guard and the caller from disagreeing about which cards are
// finished.
//
// Typed errors → status:
//   JobAuthError             → 401 (bad service bearer / missing-or-expired token)
//   ProjectNotFoundError     → 404 (cross-tenant, or a token scoped elsewhere)
//   ProjectAccessDeniedError → 404 browse (never 403 — no existence leak)
export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    /* istanbul ignore next -- `mapJobRequestError` renders every error
       `authenticateAndLimitJobRequest` is documented to throw (JobAuthError →
       401, JobRateLimitedError → 429); this arm is reachable only if that
       function grows a third failure mode, which no test can produce without
       mocking the auth module. Kept rather than swallowed: reporting an unknown
       failure as one of the two above would name the wrong reason. */
    throw err;
  }

  try {
    const result = await aiBoundaryService.readTerminalStatuses(auth.projectId, auth.ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      // 'browse' is the only kind a read can raise; an 'edit' denial cannot
      // arise here and is mapped rather than folded into the 404, so a future
      // write on this path could not inherit a silent misclassification.
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
