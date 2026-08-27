import type { JobEventName } from './types';

/**
 * THE FAST LANE'S INTERACTIVE-LATENCY BUDGET (MOTIR-3247, under MOTIR-3245).
 *
 * ⚠️ THIS IS A CONTRACT, NOT A MECHANISM, AND THAT IS WHY IT EXISTS. MOTIR-3245
 * was filed because a `work-item/transitioned` consumer landed **17 min 18 s**
 * after its event, and for a day nobody could tell a stale tracker from a broken
 * one — an hour of MOTIR-3229's investigation went on deciding whether status
 * derivation had failed. It had not. It was queued. Nothing said how fast it was
 * supposed to be, so there was no number to be wrong against.
 *
 * The card's original remedies — lane separation, event `priority`, a supervisor
 * rewrite — all descended from a mechanism that MOTIR-3246 then measured and
 * ruled out (`docs/decisions/job-lane-occupancy.md` §1, §4). **This survived that
 * because it never depended on the mechanism being right.** Whatever turns out to
 * cost the latency, the budget is what makes it visible.
 *
 * ## What the fast lane IS
 *
 * The consumers of the events below are what a person is waiting on when they
 * change a work item's status: the rollup that closes a parent, the notification
 * that tells a watcher, the bell, the automation rules. A delay here is not a
 * slow background job — it is the tracker appearing to be wrong.
 *
 * ## The number, and why it is a target rather than a description
 *
 * **{@link FAST_LANE_LATENCY_BUDGET.p95Ms} was written down at the value we
 * want rather than the value we had**, against a substrate that missed it by
 * four to six times. Five seconds is the largest delay that still reads as "it
 * happened" to somebody who just clicked something and is looking at the screen.
 * It is not derived from any measurement — deriving a budget from the current
 * p95 would make it a description of today rather than a commitment about
 * tomorrow. That is why the readings below sit BESIDE it rather than replacing
 * it, and why there are two of them.
 *
 * ## Two readings, two substrates — and the comparison is the point (MOTIR-3464)
 *
 * The fast lane has run on two different job substrates, so the constant carries
 * one measurement of each. Neither overwrites the other: a constant holding only
 * the current p95 can support *"the fast lane is fast"* and cannot support
 * *"it went from 29.4 s to 2.2 s"*, which is the sentence anybody weighing
 * MOTIR-3413 will want to check.
 *
 * | | {@link FAST_LANE_LATENCY_BUDGET.inngestBaseline} | {@link FAST_LANE_LATENCY_BUDGET.engineBaseline} |
 * |---|---|---|
 * | substrate | Inngest Cloud | the Postgres job engine |
 * | measured  | 2026-08-23, 72 h, n=556 | 2026-08-27, 18 h, n=363 |
 * | median    | 1 300 ms | 356 ms |
 * | p95       | 29 400 ms — **outside** the budget | 2 172 ms — **inside** the budget |
 * | max       | 93 300 ms | 4 160 ms |
 *
 * **On the substrate now in production, the budget is MET** — and by a margin
 * worth stating precisely: the single worst sample in eighteen hours (4 160 ms)
 * is inside it, not merely the 95th percentile. MOTIR-3463 cut the
 * `work-item/transitioned` consumers over to the engine on 2026-08-26; the lane
 * became whole at 15:36:59Z, and the engine reading's window begins after that.
 *
 * ⚠️ **`tests/jobs/fast-lane-latency-budget.test.ts` asserts the relation
 * against {@link FAST_LANE_LATENCY_BUDGET.engineBaseline}, because that is the
 * substrate in production.** If the lane ever moves again, that assertion must
 * move with it — a guard reading a baseline for a lane nothing runs on cannot
 * fail for the reason it names.
 *
 * ## What the engine reading does and does NOT establish
 *
 * `docs/decisions/job-lane-occupancy.md` §6 attributes the *Inngest* tail to
 * **arrival burstiness** — slow events follow 3–4× SHORTER quiet periods than
 * fast ones, and their consumers also take 12.9–20.2 s to FINISH against 1.7 s
 * for a fast event's — with the leading hypothesis being saturation of the
 * single unpartitioned account-level capacity (§3), which nothing in this
 * repository configures or bounds.
 *
 * **The engine reading is CONSISTENT with that hypothesis and does not settle
 * it.** What it does establish is narrower and still useful: the engine window
 * contained a genuine burst — a 53× arrival spread, peak 53 events/h against a
 * trough of 1 — and produced a 2 172 ms p95 and a 4 160 ms max anyway. So
 * burstiness ALONE is not sufficient to produce a 29-second tail. The §3 reading
 * that would settle the rest is still the account's configured concurrency
 * limit, which is dashboard-only (MOTIR-3406).
 *
 * **Do not read the two rows as "the migration made it fast."** They were taken
 * on different substrates in different windows with different sample counts, and
 * this epic deliberately excluded the fan-out reduction so that attribution would
 * stay decidable. What is recorded here is measured behaviour, not a cause.
 */
export const FAST_LANE_LATENCY_BUDGET = {
  /**
   * The trigger events whose consumers this budget covers.
   *
   * ⚠️ FROZEN ON PURPOSE. `tests/jobs/fast-lane-latency-budget.test.ts` asserts
   * that the set of registered functions triggered by these events is exactly
   * {@link FAST_LANE_CONSUMER_IDS}, so a fifth consumer cannot be added to the
   * lane without someone deciding whether it belongs inside the budget. That
   * failure is the guard's whole purpose — adding a consumer is precisely when
   * the latency contract is easiest to widen by accident.
   */
  events: ['work-item/transitioned'] satisfies JobEventName[] as JobEventName[],

  /**
   * The 95th-percentile event→run latency the fast lane is expected to hold.
   *
   * MET on the engine, MISSED on Inngest — see the header, and the two readings
   * below. Both are kept so a later reader can tell movement from noise.
   */
  p95Ms: 5_000,

  /**
   * ⚠️ SUBSTRATE: **INNGEST**. The measured baseline this budget was WRITTEN
   * against (MOTIR-3247), kept verbatim so the number above stayed falsifiable
   * rather than aspirational-forever — and kept still, because it is the "from"
   * half of the comparison the header's table makes.
   *
   * Taken with `scripts/experiments/inngest-fastlane-lag.mjs` against the
   * production Inngest REST API. The window's exact UTC boundaries were not
   * recorded at the time; `measuredOn` + `windowHours` is what we have.
   *
   * ⚠️ Do NOT re-measure or update this. Inngest no longer carries the fast
   * lane, so any new reading of it would be a reading of an idle system — and
   * MOTIR-3418 retires the lane this describes. It is a historical record now.
   */
  inngestBaseline: {
    measuredOn: '2026-08-23',
    windowHours: 72,
    samples: 556,
    medianMs: 1_300,
    p95Ms: 29_400,
    maxMs: 93_300,
  },

  /**
   * ⚠️ SUBSTRATE: **THE POSTGRES JOB ENGINE** — the lane in production today.
   * Recorded by MOTIR-3464 from the reading MOTIR-3594 took; re-measure with
   * `scripts/experiments/engine-fastlane-lag.mjs` (read its HOW TO RUN block
   * first — the script is not in the standalone image and must keep its
   * basename).
   *
   * **The window was chosen, not taken by default.** It starts after the lane
   * became whole (MOTIR-3463's cutover, 2026-08-26T15:36:59Z) so it does not mix
   * two substrates into one statistic, and it spans a working evening, an
   * overnight trough and a morning resumption so the p95 is measured over the
   * arrival burstiness `job-lane-occupancy.md` §6 is about: `work-item/transitioned`
   * arrived at 53/h at peak and 1/h at trough, a 53× spread.
   *
   * ⚠️ **A mild UNDER-count of steady-state load, and the date is the reason.**
   * Four of the lane's five consumers were routed to the engine during this
   * window; `plan-drift/transitioned` joined `FAST_LANE_CONSUMER_IDS` with
   * MOTIR-3579 and reached the live routing set at 11:00Z on 2026-08-27, thirty
   * minutes AFTER the window closed (MOTIR-3688). In the window it fired 65
   * times against 362 for each routed consumer — so it fires on ~18% of events,
   * and routing it adds 65 runs on top of 1 448, about **4.5% more fast-lane
   * runs**. (MOTIR-3594's own note reports that 18% as the increase in work; it
   * is the per-EVENT rate, not the per-LANE one.) An Inngest run writes no
   * `job_event` row, so it contributed no samples and the figures below are
   * unaffected — but a later reading being slightly worse is not automatically
   * a regression.
   */
  engineBaseline: {
    measuredOn: '2026-08-27',
    windowHours: 18,
    samples: 363,
    medianMs: 356,
    p95Ms: 2_172,
    maxMs: 4_160,
    /** The window's exact UTC boundaries, so the reading is re-checkable. */
    windowUtc: '2026-08-26T16:30:17Z → 2026-08-27T10:30Z',
    /** The probe that produced the six figures above. */
    script: 'scripts/experiments/engine-fastlane-lag.mjs',
  },
} as const;

/**
 * The functions that consume {@link FAST_LANE_LATENCY_BUDGET.events} today.
 *
 * Held as ids rather than derived from the registry at runtime, because the
 * whole value of the guard is that the two are compared: derive both sides from
 * the same source and the assertion can never fail.
 */
export const FAST_LANE_CONSUMER_IDS = [
  'automation-engine/transitioned',
  'notification-fan-in/transitioned',
  // ⚠️ ADMITTED DELIBERATELY (MOTIR-3579), which is what the guard above asks
  // for. `plan-drift/transitioned` keeps `Plan.status` honest — it is what moves
  // a plan to `stale` the moment a target it proposes to change is finished —
  // and the value of doing that EAGERLY is precisely that a reviewer opening the
  // queue sees the truth rather than discovering it at the Approve button. A
  // consumer whose whole point is that it has already run by the time somebody
  // looks belongs inside the latency contract, not beside it.
  //
  // Its shape fits the lane: one indexed read by `workItemId`
  // (`plan_item_work_item_id_workspace_id_idx`, added with the same card),
  // usually zero rows, and a short locked write only when a plan actually moves.
  'plan-drift/transitioned',
  'status-derivation/transitioned',
  'watcher-notify/transitioned',
] as const;
