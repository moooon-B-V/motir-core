// Named retry policies for background jobs (Story 1.6 · Subtask 1.6.4).
//
// `defineJob` accepts a `retryPolicy` shorthand instead of a bare `retries`
// number, so a job declares its retry INTENT ("this is a transient failure
// surface" / "this is safe to repeat" / "this must run at most once") rather
// than a magic count. The intent is documented per-job and surfaced in the
// 1.6.5 operator dashboard.
//
// ATTEMPTS vs RETRIES. Each policy is defined in terms of total ATTEMPTS
// (including the first). Inngest's function config takes `retries` = the number
// of ADDITIONAL attempts after the first, so `retries = maxAttempts - 1`. The
// translation lives in `policyToRetries` and is the single place that math
// happens. Inngest applies exponential backoff between attempts automatically
// (it is not a per-function knob), so the policies differ by their attempt
// BUDGET, not by a hand-tuned backoff curve: "idempotent" gets a longer budget
// because repeating the operation is safe, "none" gets exactly one shot.

export type RetryPolicyName = 'transient' | 'idempotent' | 'none';

interface RetryPolicy {
  /** Total attempts INCLUDING the first. Inngest `retries` = this minus 1. */
  maxAttempts: number;
  /** One-line rationale — documented per policy, mirrored in docs/jobs.md. */
  rationale: string;
}

export const RETRY_POLICIES: Record<RetryPolicyName, RetryPolicy> = {
  // The default surface for jobs whose failures are usually transient (a
  // flaky provider, a brief network blip). Three attempts, exponential
  // backoff between them.
  transient: {
    maxAttempts: 3,
    rationale: 'Transient failures (flaky provider / network) — retry a few times.',
  },
  // For read-only or naturally-idempotent operations where re-running is
  // always safe, so a longer budget is pure upside.
  idempotent: {
    maxAttempts: 5,
    rationale: 'Safe to repeat (read-only / naturally idempotent) — longer budget.',
  },
  // Run at most once. For jobs where a retry's semantics are WRONG — e.g. a
  // one-shot "send this signup notification once or not at all", where a
  // retry would double-notify. The first attempt is the only attempt; on
  // failure it dead-letters immediately.
  none: {
    maxAttempts: 1,
    rationale: 'Run at most once — a retry would be semantically wrong.',
  },
};

/** The default policy when a job specifies neither `retryPolicy` nor `retries`. */
export const DEFAULT_RETRY_POLICY: RetryPolicyName = 'transient';

/**
 * Translate a named policy to Inngest's `retries` value (additional attempts
 * after the first). `none` → 0, `transient` → 2, `idempotent` → 4.
 */
export function policyToRetries(name: RetryPolicyName): number {
  return RETRY_POLICIES[name].maxAttempts - 1;
}

/**
 * Resolve the effective Inngest `retries` count for a job from its options.
 * Precedence is deliberately a CONFLICT, not a silent winner: passing BOTH a
 * `retryPolicy` and an explicit `retries` is a programming error (which intent
 * wins is ambiguous), so it throws. With neither, the default policy applies.
 */
export function resolveRetries(opts: { retries?: number; retryPolicy?: RetryPolicyName }): number {
  if (opts.retryPolicy !== undefined && opts.retries !== undefined) {
    throw new Error(
      'defineJob: specify either `retryPolicy` (named) or `retries` (raw count), not both.',
    );
  }
  if (opts.retryPolicy !== undefined) return policyToRetries(opts.retryPolicy);
  if (opts.retries !== undefined) return opts.retries;
  return policyToRetries(DEFAULT_RETRY_POLICY);
}
