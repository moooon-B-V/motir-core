import { defineJob } from '../defineJob';
import type { DesignAutoRerunRequestedData } from '../types';

// THE AUTOMATIC HOSTED RE-RUN (Story MOTIR-693 · MOTIR-700;
// `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §1g) — one run
// per design Revise, enqueued by the design handler after the refusal commits. The
// policy is all in `designAutoRerunService`; this file is the trigger, the retry
// budget and the dedup key.
//
// `idempotency` on the refusal's gate id, so a redelivered event enqueues nothing new;
// the service is idempotent on the same key besides (its record is unique on the
// gate, and its start carries a key derived from it).
//
// `retryPolicy: 'transient'`: a refusal the card can explain is RECORDED, not thrown,
// so what reaches a retry is a failure nobody can name yet — a network error, a
// deadlock — which a few attempts with backoff is the right answer to.
export const designAutoRerun = defineJob(
  {
    id: 'design/auto-rerun.requested',
    retryPolicy: 'transient',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) =>
    services.designAutoRerun.attempt(ctx.event.data as DesignAutoRerunRequestedData),
);
