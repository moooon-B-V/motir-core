import { NextResponse } from 'next/server';
import { LiveProjectsQueryError, parseLiveProjectsQuery } from '@/lib/codeGraph/liveProjects';
import { authenticateServiceRequest, ServiceAuthError } from '@/lib/internalApi/serviceAuth';
import { liveProjectsService } from '@/lib/services/liveProjectsService';

// POST /api/internal/ai/live-projects (MOTIR-2197 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — motir-ai asks which of the
// tenants it stores a code graph for still exist. Its offboarding BACKSTOP
// (MOTIR-2169) subtracts this answer from its own storage enumeration to find the
// artifacts no queue row ever named.
//
// ⚠️ SERVICE-BEARER GATED, NOT JOB-TOKEN GATED, and the difference is the whole
// security story. Every other `/api/internal/ai/*` route additionally requires a
// user/project-scoped JOB TOKEN (`lib/ai/jobAuth`) — which is exactly what makes
// them safe, because such a token cannot ask about anyone else's data. This
// question is CROSS-TENANT by construction, so satisfying it with a job token
// would mean widening what a job token authorizes for every route that accepts
// one: a security change disguised as reuse. The service lane already exists for
// callers with no acting user (the Story 8.1 billing writers) and is the honest
// fit.
//
// It answers about the pairs in the body and NOTHING else — see
// `liveProjectsService` for why the direction is inverted rather than enumerating.
//
// Thin transport per CLAUDE.md: authenticate, parse, ONE service call, map errors.
//
// Typed errors → status:
//   ServiceAuthError        → 401 (missing / wrong service bearer)
//   bad JSON / query shape  → 400 (malformed body)
export async function POST(req: Request): Promise<Response> {
  try {
    authenticateServiceRequest(req);
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'LIVE_PROJECTS_QUERY_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  try {
    const pairs = parseLiveProjectsQuery(body);
    return NextResponse.json(await liveProjectsService.resolve(pairs));
  } catch (err) {
    if (err instanceof LiveProjectsQueryError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    // ⚠️ ANY OTHER FAILURE PROPAGATES AS A 500 — deliberately. A database error
    // must never be flattened into a 200 carrying `absent` verdicts: the caller
    // would delete every graph in the batch on the strength of a failed query.
    // A 500 aborts its run, which is the contract MOTIR-2169 is written to.
    throw err;
  }
}
