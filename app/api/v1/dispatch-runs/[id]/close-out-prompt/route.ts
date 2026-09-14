import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentDispatchRunCloseOutPrompt } from '@/lib/api/v1/workLoop/schema';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// GET /api/v1/dispatch-runs/{id}/close-out-prompt (Story MOTIR-4906 · MOTIR-5357)
// — the prompt a scoped run hands ONE agent before marking its pull requests
// ready, so HOW TO TEST is written onto the run target by an agent that sees the
// whole run (`docs/decisions/approval-gates.md` §9's 2026-09-13 amendment).
//
// A READ: it assembles text and writes nothing. The target and the landed cards
// come from the run's own record — the caller names only the run — and a run
// with no scope is `NO_RUN_TARGET` (422), never a defaulted target.
//
// `project:browse` at the gate, like every v1 GET: the key
// `dispatchRunService.getCloseOutPrompt` asserts on the run's project. The
// agent that PUBLISHES from this prompt is gated separately, on the tool.
export const GET = withV1Route<{ id: string }>({ permission: 'project:browse' }, async (ctx) => {
  const dto = await dispatchRunService.getCloseOutPrompt(ctx.params.id, ctx.service);
  return NextResponse.json(presentDispatchRunCloseOutPrompt(dto));
});
