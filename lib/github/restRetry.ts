// Shared GitHub REST throttling policy for the read leaves (MOTIR-3034).
//
// Extracted from `historicalPullRequests.ts`, which owned it alone until a
// second leaf needed it (`pullRequestBase.ts`). Kept as ONE module rather than
// copied, for the same reason `lib/workItems/repoDelivery.ts` is one module: two
// throttling rules against the same host, on the same installation token and the
// same rate limit, would drift into two different ideas of when GitHub is asking
// us to wait — and the one that drifts LOW is the one that gets the installation
// secondary-limited for every other caller.

/** Attempts per request before the error propagates — the initial try plus
 *  retries for a rate-limited or transiently-failed response. */
export const MAX_ATTEMPTS = 5;

/** Ceiling on ONE rate-limit sleep. GitHub's primary-limit reset can be up to an
 *  hour away; waiting that long inside a single request would look like a hang.
 *  Capped, then retried — with the attempt budget above, a genuinely exhausted
 *  primary limit ends the run with a clear error and the operator re-runs later
 *  (every caller of this policy is idempotent, so a re-run resumes). */
export const MAX_BACKOFF_MS = 60_000;

/** The floor between retries, doubled per attempt. */
export const BASE_BACKOFF_MS = 1_000;

/** Sleep, bounded by {@link MAX_BACKOFF_MS}. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_BACKOFF_MS)));
}

/** The plain exponential backoff for attempt `n` (1-based). */
export function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

/**
 * How long to wait before retrying a response, or null when the response is not
 * retryable.
 *
 * GitHub signals throttling three ways and this checks all three, because they
 * do not co-occur: a SECONDARY limit sends `retry-after` (seconds) on a 403; a
 * PRIMARY limit sends `x-ratelimit-remaining: 0` plus `x-ratelimit-reset` (unix
 * seconds) on a 403 or 429; and a bare 429 may carry neither. A 5xx is retried
 * on plain exponential backoff. Anything else — 401, 404, 422 — is a real
 * failure the caller must see, so it returns null.
 */
export function retryDelayMs(
  status: number,
  headers: { get(name: string): string | null },
  attempt: number,
  nowMs: number,
): number | null {
  const backoff = backoffMs(attempt);

  if (status === 403 || status === 429) {
    const retryAfter = Number(headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;

    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (remaining === 0 && Number.isFinite(reset) && reset > 0) {
      // `reset` is unix SECONDS. A reset already in the past still gets the
      // backoff floor rather than 0, so a clock skew cannot spin the retry loop.
      return Math.max(reset * 1_000 - nowMs, backoff);
    }
    // A 403 with no throttling signal is an ACCESS failure (the installation
    // lost the repo), not a rate limit — do not retry it.
    return status === 429 ? backoff : null;
  }

  if (status >= 500) return backoff;
  return null;
}
