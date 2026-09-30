import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { agentReviewBodySchema, presentAgentReviewResult } from '@/lib/api/v1/workLoop/agentReview';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { agentReviewRunService } from '@/lib/services/agentReviewRunService';

// POST /api/v1/work-items/{key}/agent-review (Story MOTIR-1626 · MOTIR-6821;
// `docs/decisions/hosted-agent-run.md` §8.4, `approval-gates.md` §12.3–§12.5) — a hosted
// REVIEW run submits its ONE verdict: `pass` decides the card's `agent_review` gate
// `approved` (and the approve-and-merge gate is raised for the same version);
// `changes_requested` decides it with the findings as its note, and the card is To fix.
//
// Refusals, each typed by the service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer (a browser session);
//   403 `REVIEW_RUN_TOKEN_REQUIRED` — a PAT, a device token, or a BUILD run's token;
//   403 `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` — a review run's token naming another card;
//   404 `REVIEW_GATE_NOT_FOUND` — the card has no review to answer;
//   409 `REVIEW_VERDICT_ALREADY_SUBMITTED` — this run already gave its verdict;
//   409 `REVIEW_STALE` — a late verdict (stale version, superseded or decided gate):
//       recorded on the run, nothing decided;
//   422 `INVALID_BODY` — a missing field, an unknown verdict, findings missing on
//       `changes_requested` or over the limit, named in the message.
//
// ⚠️ `acceptsRunToken` — the review run's token is its ONLY caller. One service call.
export const POST = withV1Route<{ key: string }>(
  { permission: 'work_item:edit', acceptsRunToken: true },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, agentReviewBodySchema);
    const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
    const dto = await agentReviewRunService.submitVerdict(projectId, identifier, body, ctx.service);
    return NextResponse.json(presentAgentReviewResult(dto));
  },
);
