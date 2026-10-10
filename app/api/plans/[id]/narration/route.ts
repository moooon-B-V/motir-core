import { NextResponse } from 'next/server';
import { memberThenVisitor } from '@/lib/visitor/readActor';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { planReviewService } from '@/lib/services/planReviewService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { PLAN_NARRATION_READ_WINDOW } from '@/lib/plans/planNarration';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/plans/[id]/narration?beforeSeq=<n>&limit=<k> (Story MOTIR-8060 ·
// Subtask MOTIR-8063) — an EARLIER page of the planner's narration sentences. The
// review read (`GET /api/plans/[id]`) carries the newest window and every
// session's step words; this is how the chat panel reaches back past that window.
//
// HTTP only (CLAUDE.md 4-layer): parse the page, call ONE service method, map
// typed errors exactly as the review route does. The gate is the review read's
// own (`planReviewService`'s shared reader resolution), so a Visitor reaches
// earlier sentences only of a plan they could open.

const INVALID = 'INVALID_NARRATION_PAGE';

/** A positive integer from a query value, or null. */
function positiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

async function serve(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: ServiceContext | VisitorReadContext,
): Promise<Response> {
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const beforeSeq = positiveInt(query.get('beforeSeq'));
  if (beforeSeq === null) {
    return NextResponse.json(
      { code: INVALID, error: '`beforeSeq` is required and must be an integer of at least 1.' },
      { status: 400 },
    );
  }
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? PLAN_NARRATION_READ_WINDOW : positiveInt(rawLimit);
  if (limit === null || limit > PLAN_NARRATION_READ_WINDOW) {
    return NextResponse.json(
      {
        code: INVALID,
        error: `\`limit\` must be an integer from 1 to ${PLAN_NARRATION_READ_WINDOW}.`,
      },
      { status: 400 },
    );
  }

  try {
    const page = await planReviewService.listPlanNarration(id, ctx, { beforeSeq, limit });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}

async function memberGET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  return serve(req, route, gate.ctx);
}

/** Members exactly as the review read; a VISITOR only where the review read admits one. */
export async function GET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  return memberThenVisitor(
    req,
    () => memberGET(req, route),
    (ctx) => serve(req, route, ctx),
  );
}
