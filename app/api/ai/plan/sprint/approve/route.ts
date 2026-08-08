import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
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
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

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
