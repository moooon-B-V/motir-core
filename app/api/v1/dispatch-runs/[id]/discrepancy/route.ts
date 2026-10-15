import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  presentRunDiscrepancyAcknowledgement,
  runDiscrepancyBodySchema,
} from '@/lib/api/v1/workLoop/runAgentReports';
import { runDiscrepancyService } from '@/lib/services/runDiscrepancyService';

// POST /api/v1/dispatch-runs/{id}/discrepancy (MOTIR-8722;
// `docs/decisions/run-found-trigger-dispatched-path.md` AMENDMENT 2) — the RUN records that
// its agent BUILT THROUGH a card whose plan was wrong only about the HOW. The same record as
// the `record_run_discrepancy` MCP tool, made by the CLI with the run's credential after the
// agent exits, from the points the agent wrote into `$MOTIR_AGENT_REPORT`: a hosted or
// agent-instance agent holds no Motir token and `/api/mcp` refuses the run token.
//
// Refusals, each typed by the service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer;
//   403 `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` — a run token naming another run;
//   403 `PERMISSION_DENIED` — the caller may browse the card but not edit it;
//   404 `DISPATCH_RUN_NOT_FOUND` — unknown run, another tenant's, another operator's;
//   404 `WORK_ITEM_NOT_FOUND` — the card does not exist for this caller;
//   409 `DISPATCH_RUN_TERMINAL` — the run has closed;
//   409 `DISCREPANCY_ALREADY_RECORDED` — the leg already carries a record (the agent's own call);
//   422 `UNKNOWN_DISPATCH_RUN_CARD` — the card is not an open leg of this run;
//   422 `INVALID_BODY` — no points, more than 20, or a field empty or over 2000 characters.
//
// ⚠️ `acceptsRunToken` — bound to the token's own run (`own_run`,
// `lib/hostedRuns/runTokenRoutes.ts`). One service call.
export const POST = withV1Route<{ id: string }>(
  { permission: 'work_item:edit', acceptsRunToken: true },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, runDiscrepancyBodySchema);
    const result = await runDiscrepancyService.recordDiscrepancy(body, ctx.service, {
      runId: ctx.params.id,
    });
    return NextResponse.json(presentRunDiscrepancyAcknowledgement(result));
  },
);
