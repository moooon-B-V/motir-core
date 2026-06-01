import { defineJob } from '../defineJob';

// The throwaway smoke job (Story 1.6 · Subtask 1.6.2). Proves the runtime
// end-to-end: the serve route mounts it, the in-process test harness invokes
// it, and the defineJob wrapper writes a succeeded job_run row. It returns a
// STATIC payload (no I/O, no services) so the test can assert exact equality.
//
// Removed in 1.6.4, where the canonical-pattern `system.daily-health-check`
// cron job replaces it as the reference job.

/** The fixed payload `system.ping` resolves to. Exported for the smoke test. */
export const SYSTEM_PING_PAYLOAD = { ok: true, message: 'pong' } as const;

export const systemPing = defineJob({ id: 'system.ping' }, () => {
  return SYSTEM_PING_PAYLOAD;
});
