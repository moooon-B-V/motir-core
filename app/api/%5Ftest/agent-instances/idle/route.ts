import { NextResponse } from 'next/server';
import { agentInstanceClock } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService } from '@/lib/services/agentInstanceSweepService';
import { productionGate, requireContext } from '../../_helpers';

// `POST /api/_test/agent-instances/idle` — LET TIME PASS FOR THE IDLE TIMER
// (Story MOTIR-6860 · MOTIR-6877, the E2E walk's step 4).
//
// The idle window is 30 real minutes, and the timer that closes it is a debounced
// job an acceptance clip cannot wait for. This door runs the REAL idle check —
// `agentInstanceSweepService.checkIdle`, exactly what the timer's job calls — with
// the lifecycle's own clock seam (`agentInstanceClock`) moved forward by
// `advanceMinutes` for the duration of the call, then restored. Nothing about the
// decision is faked: the agent hibernates only if, at that instant, it has really
// been quiet for the window, and the stop, the interval close and the charge are
// the ordinary ones.
//
// Gated like every `_test` door: `productionGate()` 404s it in a production build,
// and it needs a signed-in session.

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    instanceIds?: unknown;
    advanceMinutes?: unknown;
  } | null;
  const ids = Array.isArray(body?.instanceIds)
    ? body.instanceIds.filter((id): id is string => typeof id === 'string')
    : [];
  const minutes = typeof body?.advanceMinutes === 'number' ? body.advanceMinutes : 31;
  const realNow = agentInstanceClock.now;
  agentInstanceClock.now = () => new Date(Date.now() + minutes * 60_000);
  try {
    const results: Record<string, string> = {};
    for (const id of ids) results[id] = await agentInstanceSweepService.checkIdle(id);
    return NextResponse.json({ results });
  } finally {
    agentInstanceClock.now = realNow;
  }
}
