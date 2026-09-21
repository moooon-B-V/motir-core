import { NextResponse } from 'next/server';
import { monitorBugEnrichmentService } from '@/lib/services/monitorBugEnrichmentService';
import { notFound, productionGate, requireContext } from '../../_helpers';

// `_test` transport for the bug-ENRICHMENT acceptance walk (Story MOTIR-4930 ·
// Subtask MOTIR-5853). See ../../_helpers.ts for the three invariants every
// `_test` handler keeps (the production gate, a session, service-only).
//
//   POST body={ workItemId, phase?: 'both' | 'dispatch' | 'apply', jobId? }
//        → 200 { dispatch?, applied? }  (the service's own outcome values)
//
// ⚠️ WHY A DOOR AND NOT THE WORKER. The enrichment is a JOB, and the lane's job
// worker is a separate process that does not hold the motir-ai boundary fake —
// giving it `MOTIR_AI_URL` would switch the AI layer on for EVERY worker job in the
// lane (embeddings, the outward bug telemetry), each of them reaching an origin the
// fake does not answer. So this door runs the SAME two service calls the job runs
// — `dispatchEnrichment`, then `applyAuthoredBug` — synchronously in the server
// process, which is where the fake lives. It is the `_test/monitors/poll` door's
// shape exactly: that one runs the poll the half-hourly tick would. The detached
// job itself — its trigger, its durable wait, its bounded reads — is driven for
// real by the vitest gate (MOTIR-5852).
//
// `phase` lets a walk hold the result back: `dispatch` alone, a person edits the
// card, then `apply` with the returned job id.

interface EnrichBody {
  workItemId?: unknown;
  phase?: unknown;
  jobId?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => null)) as EnrichBody | null;
  const workItemId = typeof body?.workItemId === 'string' ? body.workItemId : null;
  const phase = body?.phase === 'dispatch' || body?.phase === 'apply' ? body.phase : 'both';
  if (!workItemId) return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });

  // Tenancy at the application layer: the bug must have been filed by one of THIS
  // workspace's bindings, or it is not found.
  const trigger = await monitorBugEnrichmentService.triggerForFiledBug(
    workItemId,
    auth.ctx.workspaceId,
  );
  if (!trigger) return notFound();

  if (phase === 'apply') {
    const jobId = typeof body?.jobId === 'string' ? body.jobId : null;
    if (!jobId) return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });
    return NextResponse.json({
      applied: await monitorBugEnrichmentService.applyAuthoredBug(trigger, jobId),
    });
  }
  const dispatch = await monitorBugEnrichmentService.dispatchEnrichment(trigger);
  if (phase === 'dispatch' || !dispatch.dispatched) return NextResponse.json({ dispatch });
  return NextResponse.json({
    dispatch,
    applied: await monitorBugEnrichmentService.applyAuthoredBug(trigger, dispatch.jobId),
  });
}
