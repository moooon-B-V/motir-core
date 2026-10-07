import { defineJob } from '../defineJob';
import type { GateResumeRequestedData } from '../types';

// THE AUTOMATIC HOSTED RESUME (Story MOTIR-7701 · MOTIR-7710) — one attempt per
// approval of a gate a `gated` hosted run stopped at, enqueued by both decide doors
// after the decision commits. The policy is all in `gateResumeService`; this file is
// the trigger, the retry budget and the dedup key — `designAutoRerun`'s, one decision
// over.
//
// `idempotency` on the approved gate's id, so a redelivered event enqueues nothing new;
// the service is idempotent on the same key besides (its record is unique on the gate,
// and its start carries a key derived from it).
//
// `retryPolicy: 'transient'`: a refusal the entry can explain is RECORDED, not thrown,
// so what reaches a retry is a failure nobody can name yet.
export const gateResume = defineJob(
  {
    id: 'run/gate-resume.requested',
    retryPolicy: 'transient',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => services.gateResume.attempt(ctx.event.data as GateResumeRequestedData),
);
