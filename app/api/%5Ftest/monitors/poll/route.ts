import { NextResponse } from 'next/server';
import { seedFakeMonitor, type SeedFakeMonitorInput } from '@/lib/monitors/e2eSeed';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { notFound, productionGate, requireContext } from '../../_helpers';

// `_test` transport for the monitor-ingestion acceptance walk (Story MOTIR-4929
// · Subtask MOTIR-5584). See ../../_helpers.ts for the three invariants every
// `_test` handler keeps (the production gate, a session, service-only).
//
//   POST body={ connectionId, issues?, failNextListing? }
//        → 200 + the poll's summary `{ status, filed, updated, refiled, skipped, pages }`
//
// It (a) seeds the FAKE provider's issues and one listing failure IN THE SERVER
// PROCESS — the only process whose fake the poll reads — and (b) runs
// `monitorIngestionService.pollConnection` synchronously, so a spec can say
// "an error arrives, then a check runs" without waiting on the half-hourly tick.
// The SCHEDULED path is the vitest gate's (MOTIR-5583); this door exists so the
// browser walk can show what a person sees.

interface PollBody extends SeedFakeMonitorInput {
  connectionId?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => null)) as PollBody | null;
  const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : null;
  if (!connectionId) return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });

  // Tenancy at the application layer (the dev/CI connection bypasses RLS): the
  // binding must be one of THIS workspace's, or it is not found.
  const pollable = await monitorIngestionService.listPollableConnections();
  const mine = pollable.find(
    (c) => c.id === connectionId && c.workspaceId === auth.ctx.workspaceId,
  );
  if (!mine) return notFound();

  seedFakeMonitor({ issues: body?.issues, failNextListing: body?.failNextListing });
  return NextResponse.json(await monitorIngestionService.pollConnection(connectionId));
}
