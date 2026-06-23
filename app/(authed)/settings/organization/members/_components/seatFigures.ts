import type { SeatSummaryDTO } from '@/lib/dto/billing';

// Pure seat-pricing math for the members-admin seat/billing layer (Story
// 8.1.14). Kept in a non-'use client' module so it is unit-testable in
// isolation and shared by the server page + the client island. All figures are
// DERIVED — the seat COUNT is the org membership count (passed in), the per-seat
// fee comes from `SeatSummaryDTO` (sourced from `BILLING_CATALOG`); nothing is
// hand-typed. This RENDERS the seat economics; it never writes Stripe (8.1.12
// owns the seat-quantity sync).

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const SECONDS_PER_MONTH = SECONDS_PER_YEAR / 12;

/** The recurring fee for `seats` seats at the active cadence (whole USD). */
export function seatTotal(seat: SeatSummaryDTO, seats: number): number {
  return seats * seat.perSeatUsd;
}

/**
 * The annual saving vs paying monthly, for `seats` seats — `seats × (12×monthly
 * − annual)`. Only meaningful (and only shown) for the annual cadence.
 */
export function annualSaving(seat: SeatSummaryDTO, seats: number): number {
  return seats * (seat.monthlyPerSeatUsd * 12 - seat.annualPerSeatUsd);
}

/**
 * The informational prorated charge for adding ONE seat NOW — the per-seat fee
 * scaled by the fraction of the current period still remaining. Reflects 8.1.12's
 * Stripe `always_invoice` (charged now, not deferred to renewal). `nowSeconds` is
 * unix epoch seconds; the result is whole USD, clamped to `[0, perSeatUsd]`.
 */
export function proratedAddCharge(seat: SeatSummaryDTO, nowSeconds: number): number {
  const periodLen = seat.cadence === 'annual' ? SECONDS_PER_YEAR : SECONDS_PER_MONTH;
  const remaining = Math.max(0, Math.min(periodLen, seat.currentPeriodEnd - nowSeconds));
  return Math.round(seat.perSeatUsd * (remaining / periodLen));
}

/**
 * Format a unix-seconds renewal date as a short calendar date (e.g. "1 Jul
 * 2026"). Formatted in UTC so it is deterministic across server/client (no
 * timezone-skew hydration flake — the finding-#89 lesson).
 */
export function formatRenewal(currentPeriodEnd: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(currentPeriodEnd * 1000));
}
