import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { getJob } from '@/lib/ai/motirAiClient';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';

// GET /api/ai/jobs/:id — a planning job's status + result.
//
// ⚠️ WHAT THE GATE ESTABLISHES, AND WHAT IT DOES NOT (Story MOTIR-2291 · Subtask
// MOTIR-2359). `ai:plan` establishes that the CALLER may plan in THEIR OWN
// project. It does NOT establish that the job belongs to that project: until this
// card a job was readable by its ID ALONE on both sides of the boundary — this
// route resolved the actor's active project and then called `getJob(jobId)`,
// which sent the SERVICE token and nothing else, and motir-ai's `GET /v1/jobs/:id`
// answers `getJobView(id)` with no tenant filter, returning a `JobView` that
// carries no owning project for core to check.
//
// The binding exists upstream (`PlanJob.aiProjectId` → `AiProject.coreProjectId`).
// This card starts SENDING the core project id on every job read and stream;
// MOTIR-2360 is the card that makes motir-ai ENFORCE it. Until that lands, a
// jobId held by an actor who can plan somewhere is still readable across
// projects, and saying so here is cheaper than someone re-deriving it later.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  const { jobId } = await params;

  try {
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    const job = await getJob(jobId, ctx.projectId);
    return NextResponse.json(
      { status: job.status, result: job.result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof MotirAiJobNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
