import { installSharedMockAgent } from '@/lib/test-mock-agent';
import { installGithubMergeMock } from '@/lib/test-github-merge-mock';
import {
  pullRequestReconcileService,
  PULL_REQUEST_RECONCILE_QUIET_MINUTES,
  type PullRequestReconcileSummary,
} from '@/lib/services/pullRequestReconcileService';
import { githubMergeSeamEnv } from './job-worker-process';

// ONE RECONCILE TICK, IN THE RUNNER (Story MOTIR-6843 · MOTIR-6851).
//
// `system.pull-request-reconcile` is a cron job, and no `_test` route runs a cron job.
// The tick also skips anything touched inside its quiet window, which a spec that just
// wrote its rows is always inside. So — as `ai-cadence-seed.ts`' `runCadenceTick` drives
// the cadence sweep — this calls the SHIPPED `reconcileOpenDeliveries` in-process with
// `now` past the window. Everything from the service down is real.
//
// ⚠️ GITHUB IS THE MERGE SEAM, installed IN THIS PROCESS, with the same App credentials
// the job worker carries (`githubMergeSeamEnv`, MOTIR-5837) and the runner's own control
// and journal files — so the spec steers the tick's GitHub through the file it already
// writes, and the shared agent refuses any api.github.com call the seam does not answer.

let installed = false;

function installSeam(): void {
  if (installed) return;
  const env = githubMergeSeamEnv();
  if (env['E2E_TEST_GITHUB_MERGE'] !== '1') {
    throw new Error('runReconcileTick needs the acceptance lane’s GitHub merge seam');
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  installGithubMergeMock(installSharedMockAgent());
  installed = true;
}

/** Run one reconcile pass as the cron would, once the quiet window has passed. */
export async function runReconcileTick(): Promise<PullRequestReconcileSummary> {
  installSeam();
  const now = new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);
  return pullRequestReconcileService.reconcileOpenDeliveries({ now });
}
