import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  presentUnbuildableReportAcknowledgement,
  unbuildableReportBodySchema,
} from '@/lib/api/v1/workLoop/unbuildableReport';
import { runFoundReportService } from '@/lib/services/runFoundReportService';

// POST /api/v1/dispatch-runs/{id}/unbuildable (MOTIR-8698;
// `docs/decisions/run-found-trigger-dispatched-path.md` AMENDMENT 1) — the RUN reports
// that its agent stopped because a card it holds is UNBUILDABLE. The same report as the
// `report_unbuildable_target` MCP tool, made by the CLI with the run's credential after
// the agent exits: a hosted run's agent holds no Motir token and `/api/mcp` refuses the
// run token (`hosted-agent-run.md` §8.4 hit the same wall for review), and a local
// agent may have no Motir MCP configured at all.
//
// Refusals, each typed by the service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer;
//   403 `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` — a run token naming another run;
//   403 `PERMISSION_DENIED` — the caller may browse the card but not edit it;
//   404 `DISPATCH_RUN_NOT_FOUND` — unknown run, another tenant's, another operator's;
//   404 `WORK_ITEM_NOT_FOUND` — the card does not exist for this caller;
//   409 `DISPATCH_RUN_TERMINAL` — the run has closed;
//   422 `INVALID_BODY` — a missing key, or a reason empty or over 4000 characters.
//
// ⚠️ `acceptsRunToken` — bound to the token's own run (`own_run`,
// `lib/hostedRuns/runTokenRoutes.ts`). One service call.
export const POST = withV1Route<{ id: string }>(
  { permission: 'work_item:edit', acceptsRunToken: true },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, unbuildableReportBodySchema);
    const ack = await runFoundReportService.reportUnbuildableTargetForRun(
      ctx.params.id,
      body,
      ctx.service,
    );
    return NextResponse.json(presentUnbuildableReportAcknowledgement(ack));
  },
);
