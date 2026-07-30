// The metering PERIOD key (Story MOTIR-1775 · MOTIR-1896), implementing
// `docs/decisions/ci-minutes-allowance.md` §4.5.
//
// The reset boundary is the CALENDAR MONTH in UTC. The ADR rejects the seat
// subscription's period (`SeatSummaryDTO.currentPeriodEnd`) on three grounds,
// all of which this module exists to honour:
//
//   1. It is UNDEFINED for a large share of the population — it exists only for
//      an org with an ACTIVE scaled-tracker subscription, while §4.3 gives every
//      org a pool.
//   2. It would COUPLE the meter to billing state. A calendar month is a pure
//      function of the run's own timestamp, so the meter keys a row WITHOUT
//      reading a subscription — which keeps this open-core meter free of
//      commercial coupling and keeps the `workflow_run` write a single insert.
//   3. A moving period needs BACKFILLS: a plan change or proration shifts
//      `currentPeriodEnd` and would re-bucket already-written rows. A calendar
//      month never moves.
//
// The cost §4.5 accepts is that the CI line's reset date will NOT match the seat
// line's renewal date on the billing panel; §7.3 requires the panel to state the
// reset date explicitly rather than let the user assume they coincide.

/**
 * The period a run completing at `at` is counted in: midnight UTC on the first
 * of that calendar month. PURE, total, and dependent on nothing but the instant
 * — which is the property §4.5 is buying.
 *
 * Built from the UTC components rather than a local-time constructor on purpose:
 * `new Date(y, m, 1)` would key by the SERVER's timezone, so the same run would
 * land in different periods on a UTC and a UTC+2 host — the same class of bug as
 * the `Intl`-now/timezone hydration lesson (`notes.html` #89).
 */
export function periodStartFor(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * The exclusive end of the period `periodStart` opens — the first instant of the
 * NEXT calendar month, which is also the reset moment the billing panel renders
 * as "Resets 1 Aug" (§7.3.3). December rolls the year via `Date.UTC`'s own
 * month overflow (month 12 → January of the next year), so no special case.
 */
export function periodEndFor(periodStart: Date): Date {
  return new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
}
