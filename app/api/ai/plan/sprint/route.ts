import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import {
  aiSprintPlanningService,
  SprintPlanningDisabledError,
} from '@/lib/services/aiSprintPlanningService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';

// POST /api/ai/plan/sprint (Subtask 7.13.5 · MOTIR-918) — submit a `plan_sprint`
// packing job for the active project. HTTP only: session, active project, ONE
// service call, typed errors → status codes.
export async function POST(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  // A caller outside the tenant has no active project to resolve, so a foreign
  // project reads as "none" — 404, never 403 (no existence leak).
  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  try {
    const { jobId } = await aiSprintPlanningService.submitSprintPlan(ctx);
    return NextResponse.json({ jobId }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof SprintPlanningDisabledError) {
      // 409: the request is well-formed, the project's configuration refuses it.
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof MotirAiOutOfCreditsError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
