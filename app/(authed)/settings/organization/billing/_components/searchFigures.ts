import type { SearchSpendDTO } from '@/lib/dto/aiUsage';

// Pure view-model math for the ④ Motir Search billing line (Story MOTIR-4334 ·
// MOTIR-4557; `design/billing/design-notes.md` "Amendment 2026-09-05",
// `motir-gateway` `docs/decisions/motir-search-channel.md` §4.4 / §5). Kept in a
// non-'use client' module — the `ciFigures.ts` / `seatFigures.ts` precedent — so
// every derived figure is unit-testable without mounting the panel.
//
// It DERIVES only presentation: which of the drawn states the card is in. Every
// QUANTITY it hands on comes verbatim from `BillingStatusDTO.search`, which
// `billingService` reads off the one `getOrgUsage` call the panel already makes.
// Nothing here invents a number and nothing here recomputes one.
//
// ⚠️ WHAT THIS MODULE DELIBERATELY HAS NO CONCEPT OF, because ③ Motir CI does and
// a fourth line is most likely to go wrong by analogy with the third:
//
//   · NO METER, because there is no DENOMINATOR. ② Motir AI meters its monthly
//     allotment and ③ Motir CI meters its included pool. Search has no pool, no
//     allowance and no included quantity — the gateway prices each search and
//     hands over whole credits (§4.2) — so a meter here would have to invent the
//     number it divides by. Two plain figures state what is actually known.
//   · NO PAUSED STATE. §5 decides an out-of-credit org is allowed into OVERDRAFT
//     and that search refuses nothing: a second refusal valve on grounding would
//     let a balance silently turn the planner code-blind at rung 1, whose failure
//     is invisible by construction. Refusal stays at the turn gate. There is
//     therefore no exhaustion variant to model, and `overdraft` below is an
//     INFORMATIONAL state, not a degraded one.

/** The drawn shapes of the line (design-notes amendment, panels 1–2). */
export type SearchLineVariant =
  /** Something was billed this period — the two-figure band. */
  | 'spend'
  /**
   * Applicable, but NOTHING billed this period. Deliberately not a "0 credits"
   * figure and deliberately not an empty state: an org whose runs never search
   * has nothing wrong with it, and drawing a zero as if something were is the
   * failure the ③ `nothing_to_bill` shape exists to avoid.
   */
  | 'nothing_to_bill'
  /**
   * The boundary reported no `search` block at all — a rolling deploy where the
   * motir-ai half has not landed. **UNAVAILABLE, never zero.** A customer told
   * they spent nothing on search when the figure could not be fetched concludes
   * they were not charged, and no second surface corrects them.
   */
  | 'unavailable';

export interface SearchLineFigures {
  variant: SearchLineVariant;
  /** Credits spent on search this calendar month. `null` when unavailable. */
  monthSpend: number | null;
  /** Credits spent on search all time. `null` when unavailable. */
  totalSpend: number | null;
  /**
   * True when the org's Motir AI balance is at or below zero WHILE search spend
   * is still accruing — the §5 overdraft case. It selects an INFO banner, never
   * a warning and never a paused treatment: nothing is blocked, and the banner
   * exists precisely because this is the one place a reader of ①②③ would expect
   * a refusal and must be told there is none.
   */
  overdraft: boolean;
  /** True when the figures could not be fetched — `variant === 'unavailable'`,
   *  exposed by name so a caller reads intent rather than comparing a string. */
  figuresUnavailable: boolean;
}

/**
 * The view model for the search line, or `null` when there is NO line to render.
 *
 * `null` covers exactly one case, and it is the same one ③ Motir CI treats that
 * way: the **META org** (moooon B.V.), which renders the shipped "Internal plan"
 * treatment and no billed line at all. It is never billed, so a search figure
 * beside three absent lines would be the only number on a page whose whole point
 * is that none applies.
 *
 * ⚠️ An org with NO subscription is NOT one of them. Search is charged per use
 * with no plan to be on, so an unsubscribed cloud org takes a normal line —
 * exactly as §4.3 gives one a normal CI line.
 */
export function searchLineFigures(input: {
  search: SearchSpendDTO | null;
  /** The org's Motir AI credit balance, for the §5 overdraft case. `null` when
   *  the balance itself could not be read — which is NOT overdraft. */
  balance: number | null;
}): SearchLineFigures | null {
  // ⚠️ THE `isMeta` ARM IS GONE (Story MOTIR-4337 · MOTIR-4572), and with it the
  // whole "Internal plan" treatment that replaced the storefront. It returned
  // `null` because the meta org rendered no billed line at all; every org now
  // renders the ordinary lines, and hiding this one would leave three billed
  // lines beside an absent fourth for no reason a reader could recover.

  // ⚠️ `null` is UNAVAILABLE and is checked FIRST, so it can never fall through
  // into the zero branch below. The two are one `if` apart in the source and
  // opposite in meaning, which is the whole reason this module exists.
  if (input.search === null) {
    return {
      variant: 'unavailable',
      monthSpend: null,
      totalSpend: null,
      // Not claimed while the figures are missing: an overdraft banner beside a
      // dash would assert something about spend this card cannot see.
      overdraft: false,
      figuresUnavailable: true,
    };
  }

  const { monthSpend, totalSpend } = input.search;

  return {
    variant: monthSpend === 0 ? 'nothing_to_bill' : 'spend',
    monthSpend,
    totalSpend,
    // Balance `null` is a failed READ, not a zero balance — the `ciFigures`
    // `balanceUnavailable` rule, applied to the other side of the comparison.
    overdraft: input.balance !== null && input.balance <= 0 && monthSpend > 0,
    figuresUnavailable: false,
  };
}
