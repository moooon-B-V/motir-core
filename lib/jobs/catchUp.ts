// CATCH-UP POLICIES for a SCHEDULED job (Story MOTIR-3416 · Subtask MOTIR-3470)
// — what the scheduler does with a fire the worker was down for.
//
// The sibling of `lib/jobs/retries.ts`, and deliberately shaped like it: a
// vocabulary plus a one-line rationale per member, so a job declares its INTENT
// rather than a behaviour, and the operator surface and the docs have one place
// to read the meaning off.
//
// ⚠️ IT IS NOT THE RETRY POLICY, AND CONFLATING THE TWO IS THE MISTAKE THIS FILE
// EXISTS TO PREVENT. `retryPolicy: 'idempotent'` says a handler may safely run
// the SAME tick twice. It says nothing about whether a tick that is now six hours
// STALE is still worth running at all — a sweep can be perfectly idempotent and
// still be pointless, or actively wrong, when replayed against a world that has
// moved on. The two are independent axes and each job declares both.
//
// The decision, with a row per job and the staleness argument for each, is
// `docs/decisions/job-queue-foundation.md` §11. This file is the vocabulary; that
// section is the reasoning; `lib/jobs/definitions/*` is the record of what each
// job chose. There is deliberately NO fourth place, and no default — see below.

/**
 * What the scheduler owes a job whose fire it missed.
 *
 * - `all` — enqueue EVERY missed fire, oldest first. For a job where each fire
 *   owns work no later fire will redo: it closes a named period, drains a cohort
 *   selected by its own fire time, or emits something a consumer counts per
 *   interval. **No job holds this today** (§11.5) and it is kept because the
 *   class is real and one job is one change away from joining it.
 * - `latest` — enqueue only the MOST RECENT missed fire. The right answer for a
 *   convergent sweep — one that re-derives from current state, so one run answers
 *   for every fire it missed — whose next scheduled fire is far enough away that
 *   waiting for it costs a person or a bill.
 * - `skip` — enqueue nothing; the next scheduled fire is the next run. For a
 *   convergent sweep whose next fire is imminent, where the catch-up saves less
 *   than the poll interval and, after a long outage, would fan out a burst for
 *   the sake of it.
 */
export type CatchUpPolicy = 'all' | 'latest' | 'skip';

interface CatchUpPolicyMeaning {
  /** One-line rationale — documented per policy, mirrored in docs/jobs.md. */
  rationale: string;
}

export const CATCH_UP_POLICIES: Record<CatchUpPolicy, CatchUpPolicyMeaning> = {
  all: {
    rationale: 'Every missed fire runs, oldest first — each fire owns work no later fire redoes.',
  },
  latest: {
    rationale:
      'Only the most recent missed fire runs — the sweep re-derives from current state, so one run answers for all of them.',
  },
  skip: {
    rationale:
      'Nothing runs late — the next scheduled fire is imminent and the missed work is convergent.',
  },
};

/** Every policy name, for a test or an operator surface that enumerates them. */
export const CATCH_UP_POLICY_NAMES = Object.keys(CATCH_UP_POLICIES) as CatchUpPolicy[];

// ⚠️ THERE IS NO DEFAULT, AND THAT IS THE WHOLE POINT.
//
// `retries.ts` has `DEFAULT_RETRY_POLICY` and it is right to: a job that says
// nothing about retries wants the ordinary thing, and the ordinary thing is
// harmless. A job that says nothing about catch-up does not want the ordinary
// thing — there isn't one. A per-minute fleet sweep and a monthly reconciliation
// want opposite behaviours, and a default would silently hand one of them the
// other's, for a job nobody was thinking about, discovered only as an
// unexplained replay after an outage.
//
// So the ABSENCE of a default is enforced by the TYPE: `DefineJobOptions` makes
// `catchUp` required when `cron` is present and forbidden when it is not (see
// `defineJob.ts`), and `tests/jobs/engine-units.test.ts` walks the real registry
// to assert every scheduled job carries one — never a transcribed list, so a
// fifteenth cron job fails the suite instead of shipping with no policy.
