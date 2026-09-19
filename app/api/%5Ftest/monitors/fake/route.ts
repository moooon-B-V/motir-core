import { NextResponse } from 'next/server';
import {
  readFakeMonitorCalls,
  seedFakeMonitor,
  type SeedFakeMonitorInput,
} from '@/lib/monitors/e2eSeed';
import { productionGate, requireContext } from '../../_helpers';

// `_test` transport for the error-links acceptance walk (Story MOTIR-4932 ·
// Subtask MOTIR-5734). See ../../_helpers.ts for the three invariants every
// `_test` handler keeps (the production gate, a session, service-only).
//
//   POST body={ issues?, failSearchForProject?, clearCalls? } → 200 { calls }
//   GET                                                       → 200 { calls }
//
// The FAKE provider lives in the SERVER process, so a spec reaches it only
// through a door like this one. POST seeds it WITHOUT a poll — an issue the
// picker can find that no poll has filed — arms one monitored project's search
// to fail, and opens a fresh "no provider call" window. GET reads every
// operation the server's fake was asked for since, which is how the walk proves
// that opening a work item asked the monitor nothing.

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => null)) as SeedFakeMonitorInput | null;
  seedFakeMonitor({
    issues: body?.issues,
    failSearchForProject: body?.failSearchForProject,
    clearCalls: body?.clearCalls === true,
  });
  return NextResponse.json({ calls: readFakeMonitorCalls() });
}

export async function GET(): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  return NextResponse.json({ calls: readFakeMonitorCalls() });
}
