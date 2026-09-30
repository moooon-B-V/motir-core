import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentReviewPrompt } from '@/lib/api/v1/workLoop/agentReview';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { agentReviewRunService } from '@/lib/services/agentReviewRunService';

// GET /api/v1/work-items/{key}/review-prompt (Story MOTIR-1626 · MOTIR-6821;
// `docs/decisions/hosted-agent-run.md` §8.2) — the server-assembled brief a hosted REVIEW
// run is handed: the card's two bodies, its acceptance criteria, its published How to
// test, and every pull request of the delivery set at the REVIEWED head.
//
// ── A SIBLING of `…/dispatch-prompt`, not a mode of it ──────────────────────
// The build prompt's read takes `sessionBranch`, `findingsPolicy` and `continueFrom`,
// none of which means anything to a review, and answers a BUILD shape (workflow mode,
// branches) a reviewer must never act on. Branching that route on the token's command
// would give one operation two response shapes; a sibling keeps each contract whole, and
// its run-token binding (a `review` run, its own card) is stated in one place.
//
// A READ. ⚠️ `acceptsRunToken` — and ONLY a review run's token: the service refuses a
// person's PAT and a build run's token (`REVIEW_RUN_TOKEN_REQUIRED`, 403) and another card
// (`DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, 403). A session has no bearer and is 401 here.
export const GET = withV1Route<{ key: string }>(
  { permission: 'project:browse', acceptsRunToken: true },
  async (ctx) => {
    const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
    const dto = await agentReviewRunService.getReviewPrompt(projectId, identifier, ctx.service);
    return NextResponse.json(presentReviewPrompt(dto), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  },
);
