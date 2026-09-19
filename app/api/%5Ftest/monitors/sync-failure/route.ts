import { NextResponse } from 'next/server';
import { monitorSyncProbeService } from '@/lib/services/monitorSyncProbeService';
import { notFound, productionGate, requireContext } from '../../_helpers';

// `_test` transport for the monitor-SYNC acceptance walk (Story MOTIR-4931 ·
// Subtask MOTIR-5709). See ../../_helpers.ts for the three invariants every
// `_test` handler keeps (the production gate, a session, service-only).
//
//   POST body={ connectionId, reason, workItemIdentifier } → 200 { ok: true }
//
// Records a connection's last FAILED resolve-back through the store's own
// `recordSyncFailure`, so the walk can SHOW the failure line on the row.
// PRODUCING a failure (a provider refusal inside the job) is the vitest gate's
// (MOTIR-5708) — the job runs in the worker, whose fake the spec cannot arm.

interface Body {
  connectionId?: unknown;
  reason?: unknown;
  workItemIdentifier?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : null;
  const reason = typeof body?.reason === 'string' ? body.reason : null;
  if (!connectionId || !reason) return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });
  const workItemIdentifier =
    typeof body?.workItemIdentifier === 'string' ? body.workItemIdentifier : null;

  const ok = await monitorSyncProbeService.seedSyncFailure(
    connectionId,
    { reason, workItemIdentifier },
    auth.ctx,
  );
  return ok ? NextResponse.json({ ok: true }) : notFound();
}
