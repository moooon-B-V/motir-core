import { NextResponse } from 'next/server';
import { monitorSyncProbeService } from '@/lib/services/monitorSyncProbeService';
import { productionGate, requireContext } from '../../_helpers';

// `_test` transport for the monitor-SYNC acceptance walk (Story MOTIR-4931 ·
// Subtask MOTIR-5709). See ../../_helpers.ts for the three invariants every
// `_test` handler keeps (the production gate, a session, service-only).
//
//   GET ?workItemId=<id>&toStatusKey=<key> → 200 { state: 'none' | 'pending' | 'running' | 'terminal' }
//
// Where the `monitor-issue-resolve` run for the newest transition of one bug into
// one status stands — the AUTHORITATIVE signal "nothing was resolved" waits on,
// so an empty resolve state cannot pass merely because the job has not run yet.

export async function GET(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;

  const params = new URL(req.url).searchParams;
  const workItemId = params.get('workItemId');
  const toStatusKey = params.get('toStatusKey');
  if (!workItemId || !toStatusKey) {
    return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });
  }
  const state = await monitorSyncProbeService.resolveRunFor(workItemId, toStatusKey, auth.ctx);
  return NextResponse.json({ state });
}
