import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  presentRunStopReportAcknowledgement,
  runStopReportBodySchema,
} from '@/lib/api/v1/workLoop/runAgentReports';
import { runStopReportService } from '@/lib/services/runStopReportService';

// POST /api/v1/dispatch-runs/{id}/stop (MOTIR-8722;
// `docs/decisions/run-found-trigger-dispatched-path.md` AMENDMENT 2) — the RUN records that
// its agent STOPPED on a card: the finding goes on the card as a comment and, when the run
// re-plans, the card moves to Planning with the agent's brief kept on it. The CLI posts it
// with the run's credential from what the agent wrote into `$MOTIR_AGENT_REPORT` as `stop`,
// because a hosted or agent-instance agent holds no Motir token. The re-plan is NOT
// submitted: a run's credential holds no `ai:*` key, and the comment says so.
//
// Refusals, each typed by the service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer;
//   403 `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` — a run token naming another run;
//   403 `PERMISSION_DENIED` — the caller may browse the card but not edit it;
//   404 `DISPATCH_RUN_NOT_FOUND` — unknown run, another tenant's, another operator's;
//   404 `WORK_ITEM_NOT_FOUND` — the card does not exist for this caller;
//   409 `DISPATCH_RUN_TERMINAL` — the run has closed;
//   422 `UNKNOWN_DISPATCH_RUN_CARD` — the card is not an open leg of this run;
//   422 `ILLEGAL_TRANSITION` — the workflow has no move from the card's status to Planning;
//   422 `INVALID_BODY` — an empty finding, or a field over its bound.
//
// ⚠️ `acceptsRunToken` — bound to the token's own run (`own_run`,
// `lib/hostedRuns/runTokenRoutes.ts`). One service call.
export const POST = withV1Route<{ id: string }>(
  { permission: 'work_item:edit', acceptsRunToken: true },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, runStopReportBodySchema);
    const result = await runStopReportService.reportStopForRun(ctx.params.id, body, ctx.service);
    return NextResponse.json(presentRunStopReportAcknowledgement(result));
  },
);
