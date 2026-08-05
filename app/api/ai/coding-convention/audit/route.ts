import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import {
  resolveActiveProjectContext,
  mapCodeHealthError,
  parseOffsetParam,
  parseLimitParam,
} from '../_shared';

// GET /api/ai/coding-convention/audit — the active project's latest code-health
// audit summary + a page of findings (`?findingsOffset=`, `?findingsLimit=`,
// `?repoKey=`). Per-repo scope per MOTIR-1662. Project-admin gated in the
// service. `findingsLimit` lets the audit tab read every connected repo's
// SUMMARY cheaply while fetching findings for the selected repo alone
// (MOTIR-2207 · Panel 7 §3) — a passthrough to a param the boundary already
// takes, not a change to the 7.1 contract.
export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const url = new URL(req.url);
  try {
    const audit = await aiConventionService.getAudit(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      {
        repoKey: url.searchParams.get('repoKey') ?? undefined,
        findingsOffset: parseOffsetParam(url.searchParams.get('findingsOffset')),
        findingsLimit: parseLimitParam(url.searchParams.get('findingsLimit')),
      },
    );
    return NextResponse.json(audit);
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
