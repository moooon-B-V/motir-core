import { defineJob } from '../defineJob';

// THE ORGANIZATION-DELETION REMINDERS (Story MOTIR-6306 · MOTIR-6395) — the clock
// behind `docs/decisions/organization-deletion.md` §8's "the Owner and the Admins
// are reminded seven days and one day before the erasure".
//
// The policy — which requests are due a reminder, who receives it, the notice
// ledger that makes each reminder go out exactly once — is all in
// `organizationDeletionNotifier.sendDueReminders`. This file is the schedule and
// nothing else.
//
// SYSTEM-scoped, like every retention sweep here: the due set spans tenants, so
// the notifier reads it under `withSystemContext` and each org's roster under
// that org's own context, and the ledger row is untenanted.
//
// `retryPolicy: 'idempotent'`: a reminder already recorded in
// `organization_deletion_notice` is never sent again, so re-running the tick is
// free. A per-org failure is caught and logged inside the notifier and the
// request is simply considered again on the next tick.

/**
 * 09:00 every day — a clustered minute (`SCHEDULE_CLUSTER_MINUTES`), so it opens
 * no new wake-minute. The hour is the one choice here that is about PEOPLE rather
 * than load: a reminder is read by a person deciding whether to cancel, so it is
 * sent in a working morning (UTC) rather than in the nightly cascade.
 */
export const ORGANIZATION_DELETION_REMINDERS_CRON = '0 9 * * *';

export const organizationDeletionReminders = defineJob(
  {
    id: 'system.organization-deletion-reminders',
    cron: ORGANIZATION_DELETION_REMINDERS_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('send-due-org-deletion-reminders', () =>
      services.organizationDeletionNotifier.sendDueReminders(),
    );
  },
);
