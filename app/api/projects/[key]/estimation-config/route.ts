import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { estimationService } from '@/lib/services/estimationService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { EstimationConfigForbiddenError, InvalidScaleConfigError } from '@/lib/estimation/errors';
import type { UpdateEstimationConfigInput } from '@/lib/dto/estimation';

// GET / PATCH /api/projects/[key]/estimation-config (Story 4.3 · Subtask 4.3.3)
// Read or admin-update a project's estimation config (statistic + point scale +
// custom-scale deck). The project is addressed by its workspace-unique `key`
// (the `PROD`-style identifier) — the convention every other project route uses
// (rung-2 shipped convention; the card's `[id]` reads as that key) — resolved to
// the internal project id via projectsService.getByKey, which tenant- + access-
// gates it (a missing / unbrowsable project is a 404). Thin HTTP transport per
// CLAUDE.md: resolve, one service call, map typed errors.
//
// Typed errors → status codes:
//   ProjectNotFoundError            → 404
//   EstimationConfigForbiddenError  → 403  (PATCH — non-admin)
//   InvalidScaleConfigError         → 422  (PATCH — bad statistic / scale)

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { key } = await params;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const config = await estimationService.getEstimationConfig(project.id, ctx);
    return NextResponse.json(config);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  // Forward only the present keys; the service validates enum membership +
  // the custom-scale deck (so the route stays a thin transport).
  const raw = (body ?? {}) as Record<string, unknown>;
  const patch: UpdateEstimationConfigInput = {};
  if ('estimationStatistic' in raw) {
    patch.estimationStatistic =
      raw.estimationStatistic as UpdateEstimationConfigInput['estimationStatistic'];
  }
  if ('pointScale' in raw) {
    patch.pointScale = raw.pointScale as UpdateEstimationConfigInput['pointScale'];
  }
  if ('customScaleValues' in raw) {
    patch.customScaleValues =
      raw.customScaleValues as UpdateEstimationConfigInput['customScaleValues'];
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    const config = await estimationService.updateEstimationConfig(project.id, patch, ctx);
    return NextResponse.json(config);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof EstimationConfigForbiddenError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof InvalidScaleConfigError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
