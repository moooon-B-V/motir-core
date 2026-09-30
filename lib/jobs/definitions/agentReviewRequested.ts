import { defineJob } from '../defineJob';
import type { AgentReviewRequestedData } from '../types';

// THE REVIEW RUN's START (Story MOTIR-1626 · MOTIR-6820; `hosted-agent-run.md` §8.1,
// `approval-gates.md` §12.2 / §12.6) — one hosted `review` run per REQUEST for an awaiting
// `agent_review` gate: the gate's raise (emitted after the raising transaction commits,
// MOTIR-6819), or one *Review again* press. The policy is all in
// `agentReviewStartService.startRequested`; this file is the trigger, the retry budget
// and the dedup key.
//
// `idempotency` on the REQUEST's key (`agent-review:<gateId>:raise`, or
// `…:again:<uuid>` — `lib/agentReview/reviewRunKey.ts`), so a redelivered event enqueues
// nothing new, while *Review again* is a new request with a key of its own. The same key
// is the review run's idempotency key, so even a request re-run by hand opens one run.
//
// `retryPolicy: 'transient'`: a refusal is RECORDED on the gate and returned, never
// thrown — a review that could not run is not retried by itself (§12.6). What throws is a
// database fault reading the gate, and a retry of that is safe: the start is idempotent
// on the key.
export const agentReviewRequested = defineJob(
  {
    id: 'agent-review/requested',
    retryPolicy: 'transient',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) =>
    services.agentReviewStart.startRequested(ctx.event.data as AgentReviewRequestedData),
);
