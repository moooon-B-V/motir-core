import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { aiUsageService } from '@/lib/services/aiUsageService';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { MotirAiError } from '@/lib/ai/errors';
import type { UsageScope } from '@/lib/ai/types';

// GET /api/organizations/[orgId]/usage — the org cost dashboard read (Subtask
// 7.2.11). HTTP-only (CLAUDE.md § 4-layer): session-gate, parse the drill query,
// call ONE aiUsageService method, map typed errors. The service owns the 6.10.4
// access gate (404 for a non-member, the no-leak rule) and the server-side scope
// narrowing (a non-admin member never gets an org/workspace scope), so the route
// trusts neither the orgId nor the scope params for authorization.
//
// The cost data is REMOTE (motir-ai over the 7.1 boundary) — there is no billing
// table in motir-core (the open-core invariant). A motir-ai outage surfaces as
// 502 so the dashboard shows its error/retry state, not a misleading zero.

const SCOPES: readonly UsageScope[] = ['org', 'workspace', 'project'];

function parseScope(raw: string | null): UsageScope | undefined {
  if (raw && (SCOPES as readonly string[]).includes(raw)) return raw as UsageScope;
  return undefined;
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { orgId } = await params;
  const url = new URL(req.url);

  try {
    const usage = await aiUsageService.getUsage({
      organizationId: orgId,
      actorUserId: session.user.id,
      scope: parseScope(url.searchParams.get('scope')),
      workspaceId: url.searchParams.get('workspaceId'),
      projectId: url.searchParams.get('projectId'),
      page: parsePositiveInt(url.searchParams.get('page')),
      pageSize: parsePositiveInt(url.searchParams.get('pageSize')),
    });
    return NextResponse.json(usage);
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    // motir-ai is down / rejected the read — surface a 502 so the dashboard
    // shows its error-and-retry state (the figures are temporarily unavailable;
    // the org's credits are safe).
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
