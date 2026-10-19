import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../_shared';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// GET /api/ai/coding-convention/convention — the active project's per-repo
// convention (derived, auto-used — read-only per MOTIR-1660/1663). Accepts
// `?repoKey=` to scope to a single repo; omit for the first repo / empty
// surface. Project-admin gated in the service.
// NOT rate-limited, deliberately (MOTIR-2597): this reads the stored convention back, so no
// model job is submitted and no provider money is spent on this path. The AI ceiling guards the
// doors that SUBMIT; adding one here would only cap a database read.
export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const url = new URL(req.url);
  const repoKey = url.searchParams.get('repoKey') ?? undefined;
  const versionsCursor = url.searchParams.get('versionsCursor') ?? undefined;
  try {
    const convention = await aiConventionService.getConvention(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { repoKey, versionsCursor },
    );
    return NextResponse.json(convention);
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    return mapCodeHealthError(err);
  }
}

// PUT /api/ai/coding-convention/convention — a person's save of one repository's
// convention (MOTIR-9082): body `{ repoKey, contentMd, baseVersion }`. Answers the
// re-read ConventionSurfaceDTO. `ai:configure` is enforced in the service; a stale
// `baseVersion` is a 409 carrying what won. NOT rate-limited: it submits no model job.
export async function PUT(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  const b = body as { repoKey?: unknown; contentMd?: unknown; baseVersion?: unknown } | null;
  if (
    !b ||
    typeof b.repoKey !== 'string' ||
    b.repoKey.length === 0 ||
    typeof b.contentMd !== 'string' ||
    typeof b.baseVersion !== 'number' ||
    !Number.isInteger(b.baseVersion) ||
    b.baseVersion < 0
  ) {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  try {
    const surface = await aiConventionService.saveConvention(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { repoKey: b.repoKey, contentMd: b.contentMd, baseVersion: b.baseVersion },
    );
    return NextResponse.json(surface);
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    return mapCodeHealthError(err);
  }
}
