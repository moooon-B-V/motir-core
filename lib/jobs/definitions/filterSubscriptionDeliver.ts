import { defineJob } from '../defineJob';
import type { FilterSubscriptionDeliverData } from '../types';

// Per-subscription delivery (Story 6.2 · Subtask 6.2.5) — the consumer of the
// `filter-subscription/deliver` events the hourly tick fans out. One event =
// one subscription = one durable run, so a failed resolve/read retries and
// dead-letters in isolation (the watcherNotify shape: a thin event consumer
// over a fan-out service).
//
// The handler owns NO logic: it narrows the payload and runs the service's
// `deliver` in a single durable step. `deliver` resolves the filter AS the
// subscriber (the 6.2.1 permission matrix at send time), runs the bounded list
// read, and enqueues the actual `email.send` (with the per-occurrence
// idempotency key). It RESOLVES to a typed `skipped` outcome for the expected
// "no mail" races (gone subscription/filter, lost access, gone-private,
// undecodable envelope) rather than throwing — so those don't pollute the DLQ.
//
// `retryPolicy: 'transient'`: a genuine failure here is a DB/network blip; a
// few attempts with backoff, then the 1.6.4 DLQ. The downstream email.send has
// its OWN retry budget + idempotency, so a deliver retry never double-mails.

export const filterSubscriptionDeliver = defineJob(
  { id: 'filter-subscription/deliver', retryPolicy: 'transient' },
  (ctx, services) => {
    const payload = ctx.event.data as FilterSubscriptionDeliverData;
    return ctx.step.run('deliver-subscription', () =>
      services.savedFilterSubscriptions.deliver({
        workspaceId: payload.workspaceId,
        subscriptionId: payload.subscriptionId,
        occurrenceKey: payload.occurrenceKey,
      }),
    );
  },
);
