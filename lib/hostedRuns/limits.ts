// The time limit of a HOSTED agent run (`docs/decisions/hosted-agent-run.md` §5).
//
// Every credential a hosted run holds derives its expiry from it, so nothing the
// run holds can outlive the run.

/** The wall-clock timeout of one hosted run: 90 minutes (§5). */
export const HOSTED_RUN_TIMEOUT_MS = 90 * 60_000;

/** The instant a run started at `startedAt` times out. */
export function hostedRunDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + HOSTED_RUN_TIMEOUT_MS);
}
