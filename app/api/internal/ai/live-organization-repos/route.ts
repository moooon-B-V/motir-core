import { NextResponse } from 'next/server';
import {
  LiveOrganizationReposQueryError,
  parseLiveOrganizationReposQuery,
} from '@/lib/codeGraph/liveOrganizationRepos';
import { authenticateServiceRequest, ServiceAuthError } from '@/lib/internalApi/serviceAuth';
import { liveOrganizationReposService } from '@/lib/services/liveOrganizationReposService';
import { enforceInternalServiceRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/internal/ai/live-organization-repos (MOTIR-9137) — motir-ai asks,
// for organisations it stores code graphs for, which still exist AND which
// repositories each still has connected. Its reconciler removes a graph whose
// `owner/name` is no longer among them — the graph an org rename, a repo rename
// or a transfer leaves behind, which no disconnect ever enqueued.
//
// The repository-tier twin of `live-organizations`: the same service-bearer
// gate (the question is cross-tenant, so a job token must not open it), the
// same rate limit, the same body and the same error mapping.
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
    const queries = parseLiveOrganizationReposQuery(body);
    return NextResponse.json(await liveOrganizationReposService.resolve(queries));
  } catch (err) {
    if (err instanceof LiveOrganizationReposQueryError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    // ⚠️ ANY OTHER FAILURE PROPAGATES AS A 500 — deliberately. A 200 carrying
    // empty repository lists would tell the caller every graph's repository is
    // gone.
    throw err;
  }
}
