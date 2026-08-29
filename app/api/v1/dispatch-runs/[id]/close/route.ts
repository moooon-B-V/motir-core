import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { dispatchRunCloseBodySchema } from '@/lib/api/v1/workLoop/schema';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// POST /api/v1/dispatch-runs/{id}/close (Story MOTIR-1789 · MOTIR-1792) — the
// run's terminal status, its stop reason, and every leg it left unsettled.
//
// ⚠️ ITS OWN SUB-RESOURCE RATHER THAN A `PATCH` ON THE RUN. A close is not a
// field edit: it is a one-way transition with a lock, a derived status and a
// cascade over the run's legs, and it is refused when it has already happened.
// A `PATCH` shape would invite a second caller to set `status` directly and walk
// straight past the guard that makes the reap safe.
//
// The route parses and delegates. `DISPATCH_RUN_TERMINAL` (409) is the one a
// caller most needs to recognise: it means somebody — usually the server's own
// abandoned-run reap — closed this run first, and the answer is to read it, not
// to retry.
export const POST = withV1Route<{ id: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, dispatchRunCloseBodySchema);

  const run = await dispatchRunService.close(
    ctx.params.id,
    {
      stopReason: body.stopReason,
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
    ctx.service,
  );

  return NextResponse.json(run);
});
