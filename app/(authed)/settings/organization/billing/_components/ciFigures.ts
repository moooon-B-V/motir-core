import { INCLUDED_MINUTES_PER_SEAT } from '@/lib/ciMetering/allowance';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';

// Pure view-model math for the ③ Motir CI billing line (Story MOTIR-1775 ·
// MOTIR-1903; `design/billing/design-notes.md` "Amendment 2026-07-30", ADR
// `ci-minutes-allowance.md` §7.3). Kept in a non-'use client' module — the
// `seatFigures.ts` precedent — so every derived figure is unit-testable without
// mounting the panel.
//
// It DERIVES only presentation: which of the drawn states the card is in, how
// full the meter is, and where the pool boundary sits inside an over-full bar.
// Every QUANTITY it hands on (`usedMinutes`, `poolMinutes`, `chargedCredits`, …)
// comes verbatim from `CiEntitlementStateDTO`, which
// `ciAllowanceService.getEntitlementState` produces from the org's real
// membership, the meter and the charge ledger. Nothing here invents a number,
// and nothing here decides entitlement — `state` is read, never recomputed, so
// the panel cannot disagree with the dispatch gate or MOTIR-1907's Actions pause
// about whether an org is exhausted.

/** The five drawn shapes of the line (design-notes amendment, panels 1–6). */
export type CiLineVariant =
  /** Inside the pool, and something has been consumed — the meter + derivation. */
  | 'within_allowance'
  /** Past the pool, balance still positive — visible by decision (§6.1). */
  | 'drawing_on_credits'
  /** Past the pool at balance ≤ 0 — "CI is paused", the two-option decision. */
  | 'paused'
  /**
   * Applicable, but NOTHING consumed this period (§7.3.6). Deliberately not an
   * empty state and not a "0 of 1,800" meter: an org whose repositories are all
   * its own has a pool it will simply never draw on, and the line says so.
   */
  | 'nothing_to_bill';

export interface CiLineFigures {
  variant: CiLineVariant;
  /** Linux-equivalent minutes consumed this calendar month. */
  usedMinutes: number;
  /** `max(members × 300, 1000)` — the included pool. */
  poolMinutes: number;
  /** `max(0, pool − used)`. */
  remainingMinutes: number;
  /** `max(0, used − pool)`. */
  overageMinutes: number;
  /** Credits this period's overage has actually drawn — CI's spend, not AI's. */
  chargedCredits: number;
  /** Org membership count the pool was derived from. */
  memberCount: number;
  /** True when the 1,000-minute floor bound, so the derivation says so instead
   *  of printing a seat sum the arithmetic does not support. */
  floorApplied: boolean;
  /** The per-seat constant the derivation quotes (§1). */
  perSeatMinutes: number;
  /** ISO-8601 first instant of next month — "Resets {date}" (§4.5). */
  resetsAt: string;
  /** Meter fill, 0–100. Saturates at 100 once past the pool. */
  meterPct: number;
  /** Where the pool ends inside a SATURATED bar, 0–100, or `null` when the bar
   *  is not saturated (there is no boundary to mark inside it). */
  tickPct: number | null;
  /** True past the pool — selects the shipped `Meter` `low` (warning) variant. */
  over: boolean;
  /** motir-ai could not be reached for the balance. A real value, never
   *  exhaustion and never rendered as a misleading zero. */
  balanceUnavailable: boolean;
}

function pct(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * The view model for the CI line, or `null` when there is NO line to render.
 *
 * `null` covers exactly the ADR's not-applicable cases, which the DTO already
 * carries as `applicable: false` / `state: 'bypassed'`: a self-hosted build
 * (§8.5 — and that page 404s before this anyway), no provisioning org configured
 * (nothing can be Motir-owned), and the META org (§4.4), which renders the
 * shipped "Internal plan" treatment and no CI line. An org with NO seat
 * subscription is NOT one of them — §4.3 gives it the same pool as any other
 * cloud org, so it takes a normal line.
 */
export function ciLineFigures(ci: CiEntitlementStateDTO): CiLineFigures | null {
  if (!ci.applicable || ci.state === 'bypassed') return null;

  const over = ci.overageMinutes > 0;
  const variant: CiLineVariant =
    ci.state === 'ci_credits_exhausted'
      ? 'paused'
      : ci.state === 'drawing_on_credits'
        ? 'drawing_on_credits'
        : ci.consumedMinutes === 0
          ? 'nothing_to_bill'
          : 'within_allowance';

  return {
    variant,
    usedMinutes: ci.consumedMinutes,
    poolMinutes: ci.poolMinutes,
    remainingMinutes: ci.remainingMinutes,
    overageMinutes: ci.overageMinutes,
    chargedCredits: ci.chargedCredits,
    memberCount: ci.memberCount,
    floorApplied: ci.floorApplied,
    perSeatMinutes: INCLUDED_MINUTES_PER_SEAT,
    resetsAt: ci.periodEnd,
    meterPct: over ? 100 : pct(ci.consumedMinutes, ci.poolMinutes),
    // Inside the pool the bar's own end IS the boundary, so a tick there would
    // be a notch on the edge — drawn only once the bar saturates.
    tickPct: over ? pct(ci.poolMinutes, ci.consumedMinutes) : null,
    over,
    balanceUnavailable: ci.balance === null,
  };
}
