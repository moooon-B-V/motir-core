import { NextResponse } from 'next/server';
import { requireCompliantSession, refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import {
  aiSprintPlanningService,
  SprintPlanApproveError,
} from '@/lib/services/aiSprintPlanningService';
import { SprintAssignmentValidationError } from '@/lib/ai/sprintAssignment';
import { NotSprintAdminError, SprintNotFoundError } from '@/lib/sprints/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { MotirAiError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// POST /api/ai/plan/sprint/approve (Subtask 7.13.5 · MOTIR-918) — commit an
// APPROVED sprint packing. The body carries the packing the human approved,
// possibly edited; the service re-validates it independently of the planner and
// persists it through the Epic-4 sprint services in ONE transaction. HTTP only.
//
// Body: `{ jobId: string, approvedDelta?: SprintAssignmentDelta }`. Omitting
// `approvedDelta` approves the job's own proposal untouched.
// NOT rate-limited, deliberately (MOTIR-2597): this materializes a plan that was already
// generated, so no model job is submitted and no provider money is spent on this path. The AI
// ceiling guards the doors that SUBMIT; adding one here would only cap a database read.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  // The 2FA hold (MOTIR-3653) — placed AFTER the no-project arm, which keeps
  // its own answer. `ctx.userId` is the session user `getWorkspaceContext`
  // already resolved, so this costs one policy query and no second auth trip.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || !jobId.trim()) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` is required.' },
      { status: 400 },
    );
  }
  const approvedDelta = (body as { approvedDelta?: unknown })?.approvedDelta;

  try {
    const result = await aiSprintPlanningService.approveSprintPlan(
      jobId.trim(),
      approvedDelta,
      ctx,
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    // Both re-validation stages are a 400 — the submitted packing is bad and
    // NOTHING was written. They stay distinct codes so a client can tell a
    // malformed body from a legal-shape-but-illegal-packing.
    if (err instanceof SprintAssignmentValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof SprintPlanApproveError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    // Surfaced by the Epic-4 services the persist reuses — the 6.4 sprint-admin
    // gate, and the tenancy 404s (a foreign row is "not found", never 403).
    if (err instanceof NotSprintAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof SprintNotFoundError || err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
