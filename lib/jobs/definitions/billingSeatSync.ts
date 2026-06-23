import { defineJob } from '../defineJob';
import type { BillingSeatSyncData } from '../types';

// Scaled-tracker SEAT SYNC (Story 8.1 · Subtask 8.1.12) — resync an org's Stripe
// seat `quantity` to its current active-member count. Enqueued best-effort AFTER
// an org-membership add/remove commits (enqueueScaledTrackerSeatSync), so a
// failed motir-ai/Stripe call can never roll back or block the membership change
// (the side-effects-outside-tx rule; PROD-443).
//
// SYSTEM-scoped (no workspaceId — an org spans workspaces): the handler reads the
// org + member count under withSystemContext, like every `system.*` job.
//
// `retryPolicy: 'idempotent'`: the sync is absolute (recompute-from-truth) and
// the endpoint skips the Stripe write when already at quantity, so it converges
// on re-run by construction — worth Inngest's full 5-attempt budget against a
// transient motir-ai/Stripe blip. The same handler IS the reconcile path: a
// re-run re-derives the live count, so a dropped enqueue self-heals on the next
// membership change (or a manual replay).
export const billingSeatSync = defineJob(
  { id: 'system.billing-seat-sync', retryPolicy: 'idempotent' },
  async (ctx, services) => {
    const { organizationId } = ctx.event.data as BillingSeatSyncData;
    return ctx.step.run('sync-seat-quantity', () =>
      services.billing.syncScaledTrackerSeatQuantity(organizationId),
    );
  },
);
