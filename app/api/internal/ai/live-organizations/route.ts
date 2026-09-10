import { NextResponse } from 'next/server';
import {
  LiveOrganizationsQueryError,
  parseLiveOrganizationsQuery,
} from '@/lib/codeGraph/liveOrganizations';
import { authenticateServiceRequest, ServiceAuthError } from '@/lib/internalApi/serviceAuth';
import { liveOrganizationsService } from '@/lib/services/liveOrganizationsService';
import { enforceInternalServiceRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/internal/ai/live-organizations (MOTIR-4647 · MOTIR-4642) — motir-ai
// asks which of the ORGANISATIONS it stores a code graph for still exist. Once
// the graph is keyed to the organisation, its reconciler subtracts THIS answer
// from its own bucket enumeration to find the artifacts no queue row ever named.
//
// The org-tier twin of `live-projects` (MOTIR-2197 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5). The gate, the rate limit,
// the parse-then-one-service-call shape and the error mapping are that route's,
// deliberately unchanged — the consumer switches on one contract for both reads.
//
// ⚠️ SERVICE-BEARER GATED, NOT JOB-TOKEN GATED, and the difference is the whole
// security story. Every other `/api/internal/ai/*` route additionally requires a
// user/project-scoped JOB TOKEN (`lib/ai/jobAuth`) — which is exactly what makes
// them safe, because such a token cannot ask about anyone else's data. This
// question is CROSS-TENANT by construction, so satisfying it with a job token
// would mean widening what a job token authorizes for every route that accepts
// one: a security change disguised as reuse.
//
// It answers about the organisations in the body and NOTHING else — see
// `liveOrganizationsService` for why the direction is inverted rather than
// enumerating.
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

  // The shared AI ceiling (8.5.9 / MOTIR-1165), keyed on the service credential
  // because this path carries no tenant at all. After the bearer check, so an
  // unauthenticated caller cannot spend the real credential's budget.
  const limited = await enforceInternalServiceRateLimit(req);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'LIVE_ORGANIZATIONS_QUERY_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  try {
    const queries = parseLiveOrganizationsQuery(body);
    return NextResponse.json(await liveOrganizationsService.resolve(queries));
  } catch (err) {
    if (err instanceof LiveOrganizationsQueryError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    // ⚠️ ANY OTHER FAILURE PROPAGATES AS A 500 — deliberately. A database error
    // must never be flattened into a 200 carrying `absent` verdicts: the caller
    // would delete every graph in the batch on the strength of a failed query.
    // A 500 aborts its run, which is the contract MOTIR-2169 is written to.
    throw err;
  }
}
