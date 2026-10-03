// The verdict of the hosted-run probe (MOTIR-1934), the eighth probe of
// `system.daily-health-check`. The arms are written out flat so the memoized
// step's pinned shape reads as plain objects.

/** One metered run in a Motir-owned org that ran on anything but the fleet. */
export interface HostedRunOffenderDTO {
  org: string;
  repo: string;
  runId: string;
  runAttempt: number;
  completedAt: string;
  /**
   * The runner FAMILIES the run's jobs classified as, every one of them other
   * than the fleet. The meter stores `classifyRunner()`'s output per family, not
   * the raw labels, so the family is what there is to report: `linux_x64` is an
   * `ubuntu-*` label, and `unknown` is an unpriced, empty or unreadable one.
   */
  families: string[];
}

export type HostedRunProbeVerdictDTO =
  | {
      /** No Motir-owned org is configured, so there is nothing Motir pays for. */
      verdict: 'not_applicable';
      checkedAt: string;
      windowStart: string;
      ownedOrgs: string[];
      runsChecked: number;
    }
  | {
      verdict: 'ok';
      checkedAt: string;
      windowStart: string;
      ownedOrgs: string[];
      runsChecked: number;
    }
  | {
      verdict: 'hosted_runs';
      checkedAt: string;
      windowStart: string;
      ownedOrgs: string[];
      runsChecked: number;
      offenders: HostedRunOffenderDTO[];
    };
