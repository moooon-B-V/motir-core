import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError, parseRepoScopeBody } from '../_shared';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// POST /api/ai/coding-convention/refresh — the "Re-audit now" trigger of the
// "Deepen this audit" affordance (MOTIR-1592) over the MOTIR-928 refresh seam.
// Re-runs the audit + propose for the ACTIVE project so a freshly configured
// external scanner is detected/ingested and the report refreshes. Project-admin
// gated in the service; returns the two queued job ids (the durable effect lands
// async, so the client polls the audit surface until the new audit appears).
//
// Accepts an OPTIONAL `{ repoKeys: string[] }` body (MOTIR-2247) scoping the
// derivation to those repos instead of fanning out over the whole connected set.
// A request with NO body keeps its shipped whole-set meaning exactly — the
// shipped island sends one — so this is additive at the wire, not a contract
// change. Three answers, deliberately distinct:
//
//   no body / no `repoKeys`  → 202, every connected repo (unchanged)
//   a malformed body         → 400, before the service is reached
//   a well-formed bad scope  → 422 from the service (unknown repo / empty set)
export async function POST(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;

  const scope = await parseRepoScopeBody(req);
  if (!scope.ok) {
    return NextResponse.json(
      { code: 'MALFORMED_REPO_SCOPE', error: 'repoKeys must be an array of repo refs' },
      { status: 400 },
    );
  }

  try {
    const result = await aiConventionService.reaudit(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      ctx.project.identifier,
      { repoKeys: scope.repoKeys },
    );
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    return mapCodeHealthError(err);
  }
}
