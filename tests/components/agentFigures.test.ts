import { describe, expect, it } from 'vitest';
import { agentLineFigures } from '@/app/(authed)/settings/organization/billing/_components/agentFigures';

// The Agents line's pure view model (MOTIR-6920; `design/billing/design-notes.md`
// "Delta 2026-09-29"): which drawn state the card is in, and the one derived
// number, the total.

const spend = (machineMonthSpend: number, storageMonthSpend: number) => ({
  machineMonthSpend,
  storageMonthSpend,
});

describe('agentLineFigures', () => {
  it('sums machine and storage for a paid plan', () => {
    const f = agentLineFigures({ spend: spend(1240, 900), hasPaidAiPlan: true });
    expect(f).toMatchObject({
      variant: 'figures',
      machine: 1240,
      storage: 900,
      total: 2140,
      nothingCharged: false,
      showFigures: true,
      showNoPlanNote: false,
    });
  });

  it('keeps the band at zero for a paid plan with nothing charged', () => {
    const f = agentLineFigures({ spend: spend(0, 0), hasPaidAiPlan: true });
    expect(f).toMatchObject({
      variant: 'figures',
      total: 0,
      nothingCharged: true,
      showFigures: true,
    });
  });

  it('draws only the sentence without a plan and without charges', () => {
    const f = agentLineFigures({ spend: spend(0, 0), hasPaidAiPlan: false });
    expect(f).toMatchObject({ variant: 'no_plan', showFigures: false, showNoPlanNote: true });
  });

  it('keeps real charges beside the note when the plan lapsed', () => {
    const f = agentLineFigures({ spend: spend(180, 600), hasPaidAiPlan: false });
    expect(f).toMatchObject({
      variant: 'no_plan_with_charges',
      total: 780,
      showFigures: true,
      showNoPlanNote: true,
    });
  });

  it('never turns unavailable figures into zero', () => {
    const f = agentLineFigures({ spend: null, hasPaidAiPlan: true });
    expect(f).toMatchObject({
      variant: 'unavailable',
      machine: null,
      storage: null,
      total: null,
      nothingCharged: false,
      showNoPlanNote: false,
    });
  });
});
