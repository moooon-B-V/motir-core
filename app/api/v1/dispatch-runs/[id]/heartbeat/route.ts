import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// POST /api/v1/dispatch-runs/{id}/heartbeat (Story MOTIR-6526 · MOTIR-6528) — a
// local run says it is still alive. The CLI sends one every 60 s while a run is
// open (`RUN_HEARTBEAT_INTERVAL_MS`, `lib/runs/runLiveness.ts`).
//
// No body: the only fact a heartbeat carries is WHEN it arrived, and the server
// stamps that itself — a client clock would let a laptop that slept report that
// it had been awake.
//
// `204` on success. `DISPATCH_RUN_TERMINAL` (409) means the run was closed — most
// often by the lapse reap, after the machine went silent for five minutes — and
// the CLI's answer is to stop beating, not to retry. `DISPATCH_RUN_NOT_FOUND`
// (404) covers an unknown id, another tenant's run and another operator's run
// alike.
export const POST = withV1Route<{ id: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  await dispatchRunService.heartbeat(ctx.params.id, ctx.service);
  return new NextResponse(null, { status: 204 });
});
