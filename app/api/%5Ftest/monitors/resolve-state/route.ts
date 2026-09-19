import { NextResponse } from 'next/server';
import { monitorSyncProbeService } from '@/lib/services/monitorSyncProbeService';
import { productionGate, requireContext } from '../../_helpers';

// `_test` transport for the monitor-SYNC acceptance walk (Story MOTIR-4931 ·
// Subtask MOTIR-5709). See ../../_helpers.ts for the three invariants every
// `_test` handler keeps (the production gate, a session, service-only).
//
//   GET ?workItemId=<id> → 200 [{ externalIssueId, resolveState, resolvedByMotirAt, resolveError }]
//
// What the resolve-back JOB left on each link of one bug. The job runs in the
// lane's worker, whose fake the spec cannot reach, so the walk asserts this
// DB-visible state instead of counting provider calls.

export async function GET(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;

  const workItemId = new URL(req.url).searchParams.get('workItemId');
  if (!workItemId) return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });
  return NextResponse.json(await monitorSyncProbeService.resolveStatesFor(workItemId, auth.ctx));
}
