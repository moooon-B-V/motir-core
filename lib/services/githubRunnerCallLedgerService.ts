import type { GithubRunnerCallKind } from '@/generated/prisma/client';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import {
  RunnerJitApiError,
  RunnerRegistrationRateLimitedError,
} from '@/lib/github/runnerJitConfig';
import { githubRunnerCallEventRepository } from '@/lib/repositories/githubRunnerCallEventRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE GITHUB RUNNER-CALL LEDGER'S WRITER (Story MOTIR-8953 · MOTIR-8969).
//
// A registration costs GitHub capacity whether or not a machine then booted, and
// the cases where none did (a capacity refusal, every account full, a provision
// error after the mint) are exactly the ones the headroom alert exists for. So the
// call is recorded where it is made, keyed on the RUNNER'S org — the repo's —
// never the machine's account. GitHub exposes no read of an org's registration
// count, so nothing else could be exact.
//
// ⚠️ BEST-EFFORT. A failed write is logged with a constant message and never
// fails the boot or the settle that made the call.

/** Whether a runner call's outcome means the request reached GitHub: a success,
 *  or a refusal GitHub answered. A timeout or a transport failure did not. */
export function runnerCallReachedGithub(err: unknown): boolean {
  if (err === null || err === undefined) return true;
  if (err instanceof RunnerRegistrationRateLimitedError) return true;
  return err instanceof RunnerJitApiError && err.status !== null;
}

export const githubRunnerCallLedgerService = {
  /**
   * Record `count` calls of `kind` made against the runner's org: `target`'s, or
   * the fallback org when there is no target (the provisioning org). Never throws.
   */
  async recordForTargetQuietly(
    target: GithubOrgTarget | undefined,
    kind: GithubRunnerCallKind,
    fleetShardId: string | null,
    count = 1,
  ): Promise<void> {
    const org = target?.org ?? provisioningOrgLogin();
    if (!org) return;
    await this.recordQuietly(org, kind, new Date(), fleetShardId, count);
  },

  /** Record `count` calls of `kind` to `githubOrg`. Never throws. */
  async recordQuietly(
    githubOrg: string,
    kind: GithubRunnerCallKind,
    at: Date,
    fleetShardId: string | null,
    count = 1,
  ): Promise<void> {
    if (count <= 0 || !githubOrg.trim()) return;
    try {
      await withSystemContext(async (tx) => {
        for (let i = 0; i < count; i += 1) {
          await githubRunnerCallEventRepository.record(githubOrg, kind, at, fleetShardId, tx);
        }
      });
    } catch (err) {
      console.error('[githubRunnerCallLedgerService] could not record a GitHub runner call', {
        githubOrg,
        kind,
        detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
      });
    }
  },
};
