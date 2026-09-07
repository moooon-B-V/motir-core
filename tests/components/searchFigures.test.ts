import { describe, expect, it } from 'vitest';
import { searchLineFigures } from '@/app/(authed)/settings/organization/billing/_components/searchFigures';
import type { SearchSpendDTO } from '@/lib/dto/aiUsage';

// Unit tests for the ④ Motir Search line's view model (MOTIR-4557), the
// `ciFigures.test.ts` precedent: every figure the line presents is derived here,
// so each drawn state is provable without mounting the panel.
//
// The governing rule, and the reason this module exists at all:
// **UNAVAILABLE IS NOT ZERO.** They are one `if` apart in the source and opposite
// in meaning, and a customer told they spent nothing on search when the figure
// could not be fetched concludes they were not charged.

function spend(over: Partial<SearchSpendDTO> = {}): SearchSpendDTO {
  return { totalSpend: 1204, monthSpend: 312, ...over };
}

const HEALTHY = { balance: 4420 };

describe('searchLineFigures — the drawn states', () => {
  it('reports SPEND, carrying both figures verbatim from the DTO', () => {
    const f = searchLineFigures({ ...HEALTHY, search: spend() });

    expect(f).not.toBeNull();
    expect(f!.variant).toBe('spend');
    // Verbatim: this module derives presentation, never a quantity.
    expect(f!.monthSpend).toBe(312);
    expect(f!.totalSpend).toBe(1204);
    expect(f!.figuresUnavailable).toBe(false);
  });

  it('reports NOTHING_TO_BILL for a zero month — not an empty state, and not a zero meter', () => {
    // An org whose runs never search has nothing wrong with it. All-time spend
    // is still carried, because "none this month" and "none ever" are different
    // sentences.
    const f = searchLineFigures({
      ...HEALTHY,
      search: spend({ monthSpend: 0, totalSpend: 40 }),
    });

    expect(f!.variant).toBe('nothing_to_bill');
    expect(f!.monthSpend).toBe(0);
    expect(f!.totalSpend).toBe(40);
    expect(f!.figuresUnavailable).toBe(false);
  });

  it('reports UNAVAILABLE when the boundary sent no block at all', () => {
    const f = searchLineFigures({ ...HEALTHY, search: null });

    expect(f!.variant).toBe('unavailable');
    expect(f!.figuresUnavailable).toBe(true);
    // ⚠️ NULL, not 0. A zero here would be rendered as a figure.
    expect(f!.monthSpend).toBeNull();
    expect(f!.totalSpend).toBeNull();
  });

  // ── THE ASSERTION THIS FILE EXISTS FOR (AC 3) ────────────────────────────────

  it('⚠️ UNAVAILABLE and ZERO produce different output — they must never collapse', () => {
    const unavailable = searchLineFigures({ ...HEALTHY, search: null })!;
    const zero = searchLineFigures({
      ...HEALTHY,
      search: spend({ monthSpend: 0, totalSpend: 0 }),
    })!;

    // Different variant, so a different branch renders.
    expect(unavailable.variant).not.toBe(zero.variant);
    // And different VALUES, so the two cannot render the same figure even if a
    // caller ignored the variant: `null` takes the em-dash, `0` takes "0 credits".
    expect(unavailable.monthSpend).toBeNull();
    expect(zero.monthSpend).toBe(0);
    expect(unavailable).not.toEqual(zero);
  });

  // ── ⚠️ THE META CASE IS DELETED WITH THE ARM IT TESTED (MOTIR-4572) ──────────
  //
  // It asserted that the META org rendered NO line, *"because the internal org
  // is never billed and a search figure beside three absent billed lines would
  // be the only number on a page whose whole point is that none applies."* That
  // premise is what Story MOTIR-4337 removed: the other three lines are no
  // longer absent, so this one is no longer alone, and an org classified
  // `internalBilling` is charged exactly like a customer and made whole in the
  // ledger. The line renders for every org, which is asserted by every case
  // below now that none of them takes an `isMeta`.

  it('renders a NORMAL line for an org with no subscription', () => {
    // Search is charged per use with no plan to be on, so an unsubscribed cloud
    // org is not a not-applicable case — the same way §4.3 gives one a normal CI
    // line. `balance: 0` here is the unsubscribed org's real balance.
    const f = searchLineFigures({ balance: 0, search: spend() });
    expect(f).not.toBeNull();
    expect(f!.variant).toBe('spend');
  });
});

// ── §5 — the OVERDRAFT case, which is informational and never a paused state ───

describe('searchLineFigures — overdraft (motir-search-channel.md §5)', () => {
  it('flags overdraft at a zero balance while spend is still accruing', () => {
    const f = searchLineFigures({ balance: 0, search: spend({ monthSpend: 86 }) });
    expect(f!.overdraft).toBe(true);
    // ⚠️ And it is STILL the spend variant — there is no paused/exhausted state
    // to fall into. Search refuses nothing.
    expect(f!.variant).toBe('spend');
  });

  it('flags overdraft at a NEGATIVE balance — a debit that crossed zero applies in full', () => {
    const f = searchLineFigures({ balance: -12, search: spend({ monthSpend: 86 }) });
    expect(f!.overdraft).toBe(true);
  });

  it('does NOT flag overdraft on a healthy balance', () => {
    expect(searchLineFigures({ ...HEALTHY, search: spend() })!.overdraft).toBe(false);
  });

  it('does NOT flag overdraft when nothing was billed this month', () => {
    // A zero balance with no search spend has nothing to say about search. The
    // banner explains a charge that is still being made; there is no charge.
    const f = searchLineFigures({ balance: 0, search: spend({ monthSpend: 0 }) });
    expect(f!.overdraft).toBe(false);
  });

  it('does NOT flag overdraft when the BALANCE could not be read', () => {
    // `balance: null` is a failed read, not a zero balance — the `ciFigures`
    // `balanceUnavailable` rule applied to the other side of the comparison.
    // Claiming overdraft off a missing number would assert exhaustion nobody saw.
    const f = searchLineFigures({
      balance: null,
      search: spend({ monthSpend: 86 }),
    });
    expect(f!.overdraft).toBe(false);
  });

  it('does NOT flag overdraft while the FIGURES are unavailable', () => {
    // A banner beside an em-dash would assert something about spend this card
    // cannot see.
    const f = searchLineFigures({ balance: 0, search: null });
    expect(f!.overdraft).toBe(false);
    expect(f!.figuresUnavailable).toBe(true);
  });
});
