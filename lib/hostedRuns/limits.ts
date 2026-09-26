// A hosted run's time limits (`docs/decisions/hosted-agent-run.md` §5).
//
// ONE home for the numbers every credential's expiry is derived from, so the
// run key, the run token and the git credential cannot drift apart: nothing a
// run holds may outlive it by more than the settle margin. Pure constants — a
// leaf module with no imports, safe for any layer.

/**
 * The wall-clock timeout of a hosted run, from boot: 90 minutes. A leaf's agent
 * run is capped at 60 minutes by the planning corpus; the rest is an allowance
 * for clone, install, codegraph index, push and pull request. The fleet seam's
 * own ceiling (`HOSTED_AGENT_MAX_TIMEOUT_MS`, 12 hours) is a spend backstop, not
 * this.
 */
export const HOSTED_RUN_TIMEOUT_MS = 90 * 60_000;

/** The stall window: no agent output for this long ends the run as `timed_out`. */
export const HOSTED_RUN_STALL_WINDOW_MS = 15 * 60_000;

/**
 * How long past the timeout a run's credentials stay valid, so the end path can
 * settle (close the run, link the pull request) with them: 5 minutes.
 */
export const HOSTED_RUN_SETTLE_MARGIN_MS = 5 * 60_000;

/**
 * The latest instant a credential of a run whose timeout clock starts at
 * `bootAt` may expire: boot + timeout + settle margin (§3, §5).
 *
 * A credential is minted BEFORE the container boots, so a minter passes its own
 * `now`: boot is no earlier than that, which makes this the tightest bound the
 * server can know at mint time.
 */
export function latestRunCredentialExpiry(bootAt: Date): Date {
  return new Date(bootAt.getTime() + HOSTED_RUN_TIMEOUT_MS + HOSTED_RUN_SETTLE_MARGIN_MS);
}

/** The instant a run started at `startedAt` times out (MOTIR-689). */
export function hostedRunDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + HOSTED_RUN_TIMEOUT_MS);
}
