import { inngest } from '@/lib/jobs/client';
import { isOrchestratorConfigured } from '@/lib/orchestrator';
import type { CiRunnerBootData } from '@/lib/jobs/types';

// THE `system.ci-runner-boot` DISPATCH (Story MOTIR-1916 · MOTIR-1996) — the one
// place that says what a boot event looks like, and the hot-path send that gets
// one out of the webhook the instant an intent exists.
//
// `docs/decisions/ci-runner-fleet.md` §6 budgets **p50 ≤ 30 s** from the
// `workflow_job.queued` delivery to the job starting, and the minute-granularity
// `system.ci-runner-provision-sweep` cannot meet it: a cron adds up to 60 s
// before the admission gate is even consulted. So the webhook dispatches
// directly, and the sweep stays exactly where it is — as the RECOVERY path for
// an intent this call dropped, and as the retry loop every gate deferral already
// depends on.
//
// TWO SENDERS, ONE PAYLOAD. Both callers build the event through
// `ciRunnerBootEvent`, so the shape cannot drift between the fast path and the
// recovery path — the two events race by design and must be the same event.
// Their ERROR semantics differ deliberately, which is why only one of them gets
// the swallowing wrapper below:
//
//   * the SWEEP sends inside a `step.run` under the `idempotent` retry policy —
//     a transport failure there should propagate, because Inngest retrying the
//     step is a free, correct fix;
//   * the WEBHOOK has no retry that could help. GitHub retries a 500 delivery,
//     and a redelivery cannot re-send an event that failed to send; it would
//     only re-run the whole handler for an intent that already exists. So the
//     failure is logged and swallowed, the delivery is acked, and the sweep
//     picks the intent up within the minute.

/** The canonical `system.ci-runner-boot` event for one provisioning intent.
 *
 *  ⚠️ THE PAYLOAD IS THE INTENT ID AND NOTHING ELSE (see `CiRunnerBootData`):
 *  every attribution the boot needs is on the intent row, and a second copy in
 *  the event is a second copy that can disagree. `workspaceId` rides along only
 *  for the `job_run` ledger's scoping. */
export function ciRunnerBootEvent(intentId: string): {
  name: 'system.ci-runner-boot';
  data: CiRunnerBootData;
} {
  return { name: 'system.ci-runner-boot', data: { intentId, workspaceId: '' } };
}

/** What the hot-path dispatch did — returned rather than logged-only so the
 *  seam is assertable without reading stdout. The webhook does not act on it:
 *  the delivery's outcome is what `recordQueuedJob` decided, and a boot that
 *  could not be dispatched is still an intent that was recorded. */
export type CiRunnerBootDispatchOutcome = 'dispatched' | 'not_configured' | 'send_failed';

/**
 * Dispatch the boot for a freshly recorded intent, from the webhook, in the same
 * request. NEVER THROWS — see the module header.
 *
 * Gated on `isOrchestratorConfigured()`, which is the SAME condition
 * `ciRunnerBootService.listRunnableIntentIds` applies before the sweep fans
 * anything out: a deployment that cannot provision a container (a self-hosted
 * `motir-core`, or a cloud deploy whose fleet env vars are not set yet) should
 * not emit an event whose only possible outcome is `not_configured`. The intent
 * is still recorded, so nothing is lost — the moment the deployment IS
 * configured, the sweep drains what accumulated.
 */
export async function dispatchCiRunnerBoot(intentId: string): Promise<CiRunnerBootDispatchOutcome> {
  if (!isOrchestratorConfigured()) return 'not_configured';
  try {
    await inngest.send(ciRunnerBootEvent(intentId));
    return 'dispatched';
  } catch (err) {
    console.error(
      `[ciRunnerBoot] the hot-path boot dispatch for intent ${intentId} failed to enqueue; ` +
        `the delivery is still acked and the provision sweep will pick the intent up ` +
        `within the minute:`,
      err,
    );
    return 'send_failed';
  }
}
