// A hosted run's time limits (`docs/decisions/hosted-agent-run.md` §5, as the
// run-dies decision MOTIR-6525 amends it: no wall-clock limit but the backstop).
//
// ONE home for the numbers every credential's expiry is derived from, so the
// run key, the run token and the git credential cannot drift apart: nothing a
// run holds may outlive it by more than the settle margin. Pure constants — a
// leaf module with no imports, safe for any layer.

/**
 * The longest a hosted run lives, from boot: the fleet's 12-hour spend BACKSTOP.
 *
 * ⚠️ THERE IS NO OTHER WALL-CLOCK LIMIT (the run-dies decision, MOTIR-6525, which
 * withdrew `hosted-agent-run.md` §5's 90 minutes). A healthy run producing output
 * is not stopped by a clock — a parent worked through its children legitimately
 * takes hours; only the 15-minute no-output stall below ends a live run early.
 * So the container's hard kill, the run key's expiry and the run credential's
 * expiry are all this one figure. It equals `HOSTED_AGENT_MAX_TIMEOUT_MS`, the
 * container seam's own ceiling, and a test holds the two equal (this module stays
 * a leaf with no imports, so it states the number rather than importing it).
 */
export const HOSTED_RUN_TIMEOUT_MS = 12 * 60 * 60_000;

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
