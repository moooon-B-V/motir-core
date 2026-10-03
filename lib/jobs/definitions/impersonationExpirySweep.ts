import { defineJob } from '../defineJob';

// Staff "View as" session expiry sweep (Story 10.3 · MOTIR-749).
//
// The GATE refuses a staff session from its `expires_at` whether or not anything
// has closed it — the time-box never depends on this job. What this job owns is
// the TRAIL: a session the operator abandoned (closed the tab, never came back)
// is never seen by the gate again, so without a sweep its `user.impersonation_end`
// row would never be written and the audit log would show a session that began
// and never ended. Each pass records `endedBy: expiry` for every open session past
// its box, one audited transaction per session, the operator as actor.
//
// `retryPolicy: 'idempotent'`: an end locks the row and is a no-op on a session
// already ended, so a re-run converges; bounded per pass by the service.

/** Every 5 minutes — the one sub-hourly cadence (`SUB_HOURLY_CADENCE`). */
export const IMPERSONATION_EXPIRY_SWEEP_CRON = '*/5 * * * *';

export const impersonationExpirySweep = defineJob(
  {
    id: 'system.impersonation-expiry-sweep',
    cron: IMPERSONATION_EXPIRY_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('close-expired-staff-sessions', () =>
      services.impersonation.closeExpiredSessions(),
    );
  },
);
