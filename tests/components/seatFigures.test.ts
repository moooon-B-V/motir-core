import { describe, expect, it } from 'vitest';
import {
  annualSaving,
  formatRenewal,
  proratedAddCharge,
  seatTotal,
} from '@/app/(authed)/settings/organization/members/_components/seatFigures';
import type { SeatSummaryDTO } from '@/lib/dto/billing';

// Pure unit tests for the seat-pricing math (Subtask 8.1.14). Deterministic —
// no DOM, no clock except the `nowSeconds` we pass in.

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
// 1893456000 = 2030-01-01T00:00:00Z (a fixed renewal anchor).
const RENEWAL = 1893456000;

const annual: SeatSummaryDTO = {
  status: 'active',
  cadence: 'annual',
  perSeatUsd: 40,
  monthlyPerSeatUsd: 5,
  annualPerSeatUsd: 40,
  currentPeriodEnd: RENEWAL,
  canManageBilling: true,
};

describe('seatFigures', () => {
  it('seatTotal = seats × per-seat fee', () => {
    expect(seatTotal(annual, 6)).toBe(240);
    expect(seatTotal(annual, 7)).toBe(280);
    expect(seatTotal(annual, 0)).toBe(0);
  });

  it('annualSaving = seats × (12×monthly − annual)', () => {
    // 6 × (5×12 − 40) = 6 × 20 = 120 (the design’s "saves $120/yr")
    expect(annualSaving(annual, 6)).toBe(120);
  });

  it('proratedAddCharge scales the per-seat fee by the remaining period fraction', () => {
    // Whole period remaining → the full per-seat fee.
    expect(proratedAddCharge(annual, RENEWAL - SECONDS_PER_YEAR)).toBe(40);
    // Half remaining → ~half.
    expect(proratedAddCharge(annual, RENEWAL - SECONDS_PER_YEAR / 2)).toBe(20);
    // Past the period end → clamped to 0.
    expect(proratedAddCharge(annual, RENEWAL + 1000)).toBe(0);
  });

  it('proratedAddCharge uses the monthly period length for a monthly cadence', () => {
    const monthly: SeatSummaryDTO = { ...annual, cadence: 'monthly', perSeatUsd: 5 };
    const SECONDS_PER_MONTH = SECONDS_PER_YEAR / 12;
    expect(proratedAddCharge(monthly, RENEWAL - SECONDS_PER_MONTH)).toBe(5);
    expect(proratedAddCharge(monthly, RENEWAL - SECONDS_PER_MONTH / 2)).toBe(3); // round(2.5)
  });

  it('formatRenewal renders a stable UTC calendar date', () => {
    expect(formatRenewal(RENEWAL, 'en-GB')).toBe('1 Jan 2030');
  });
});
