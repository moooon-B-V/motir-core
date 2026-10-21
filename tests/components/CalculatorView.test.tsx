// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import { BILLING_CATALOG, INCLUDED_TRACKER_SEATS_PER_AI_PLAN } from '@/lib/billing/catalog';
import type { BillingCadence } from '@/lib/billing/catalog';
import type {
  BillingStatusDTO,
  CalculatorCategoriesDTO,
  CalculatorEmptyCategoryDTO,
  CalculatorEstimateDTO,
} from '@/lib/dto/billing';
import type { CalculatorOutcome } from '@/lib/billing/calculatorClient';
import { CalculatorView } from '@/app/(authed)/settings/organization/billing/_components/CalculatorView';

// The Calculator view's state matrix (MOTIR-8639), against a STUBBED client helper:
// the categories read, the three recommendation arms, both cadences, the seat line,
// the upgrade line, every refusal and every door outcome. The helper's own wire
// behaviour is `calculatorClient.test.ts`'s; the engine's figures are its repository's —
// the answers below are fixtures, which is the point: this view prints what it is given.

const client = vi.hoisted(() => ({
  fetchCalculatorCategories: vi.fn(),
  fetchCalculatorEstimate: vi.fn(),
}));
vi.mock('@/lib/billing/calculatorClient', () => client);

const m = enMessages.billing.calculator;

function categories(over: Partial<CalculatorCategoriesDTO> = {}): CalculatorCategoriesDTO {
  return {
    version: 2,
    categoryRuleVersion: 'rule-1',
    modelsReadAt: '2026-10-21T00:00:00.000Z',
    cadences: ['annual', 'monthly'],
    defaultCadence: 'annual',
    categories: [
      { key: 'economy', models: [{ id: 'model-a', provider: 'p' }] },
      {
        key: 'balanced',
        models: [
          { id: 'model-b', provider: 'p' },
          { id: 'model-c', provider: 'p' },
        ],
      },
      { key: 'flagship', models: [{ id: 'model-d', provider: 'p' }] },
    ],
    ...over,
  };
}

function estimate(over: Partial<CalculatorEstimateDTO> = {}): CalculatorEstimateDTO {
  return {
    version: 2,
    kind: 'estimate',
    profilesVersion: 'profiles-1',
    categoryRuleVersion: 'rule-1',
    cadence: 'annual',
    credits: { low: 11_000, high: 44_000 },
    perItemCredits: { planning: 100, running: 200 },
    split: {
      count: 2,
      categories: [
        { key: 'balanced', weight: 0.5, models: ['model-b'] },
        { key: 'flagship', weight: 0.5, models: ['model-d'] },
      ],
    },
    recommendation: { planKey: 'max_x2', planName: 'Max ×2', monthlyPriceUsd: 200 },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: { units: 0, credits: 0, priceUsd: 0 },
    },
    ceiling: { credits: 60_000, exceeded: false, excessCredits: 0, outcome: 'within_ladder' },
    ...over,
  };
}

/** Where the high end lands on a larger pool the catalog does not list. */
function larger(): CalculatorEstimateDTO {
  return estimate({
    credits: { low: 61_000, high: 120_000 },
    recommendation: { planKey: 'pool_x', planName: 'Pool X', monthlyPriceUsd: 555 },
    ceiling: { credits: 60_000, exceeded: true, excessCredits: 60_000, outcome: 'larger_pool' },
  });
}

/** Above the regular ladder with no larger pool: the top plan and the excess in top-ups. */
function above(): CalculatorEstimateDTO {
  return estimate({
    credits: { low: 61_000, high: 160_000 },
    topUp: {
      low: { units: 1, credits: 1_000, priceUsd: 5 },
      high: { units: 101, credits: 101_000, priceUsd: 505 },
    },
    ceiling: { credits: 60_000, exceeded: true, excessCredits: 100_000, outcome: 'top_ups_only' },
  });
}

const answer = <T,>(value: T): CalculatorOutcome<T> => ({ kind: 'answer', value });

function status(over: { tierKey?: string; active?: boolean } = {}): BillingStatusDTO {
  const tierKey = over.tierKey ?? 'free';
  return {
    catalog: BILLING_CATALOG,
    motirAi: {
      tier: { key: tierKey, name: tierKey, monthlyCreditAllotment: 0 },
      balance: 0,
      pendingDowngrade: null,
      subscription: {
        status: over.active ? 'active' : null,
        currentPeriodEnd: null,
        priceId: null,
        planTier: null,
      },
    },
  } as unknown as BillingStatusDTO;
}

interface Handles {
  back: ReturnType<typeof vi.fn>;
  goToPlan: ReturnType<typeof vi.fn>;
  onCadence: ReturnType<typeof vi.fn>;
}

function renderView(
  opts: {
    data?: BillingStatusDTO;
    cadence?: BillingCadence;
    messages?: Record<string, unknown>;
  } = {},
): Handles {
  const handles: Handles = { back: vi.fn(), goToPlan: vi.fn(), onCadence: vi.fn() };
  render(
    <CalculatorView
      orgId="org1"
      orgName="Acme"
      data={opts.data ?? status()}
      cadence={opts.cadence ?? 'annual'}
      onCadence={handles.onCadence}
      back={handles.back}
      goToPlan={handles.goToPlan}
    />,
  );
  return handles;
}

async function ready() {
  await screen.findByRole('button', { name: /Economy/ });
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function pick(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

async function ask(low = '40', high = '60', picks: RegExp[] = [/Balanced/, /Flagship/]) {
  await ready();
  type(m.inputs.lowLabel, low);
  type(m.inputs.highLabel, high);
  for (const p of picks) pick(p);
  fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
}

beforeEach(() => {
  client.fetchCalculatorCategories.mockReset().mockResolvedValue(answer(categories()));
  client.fetchCalculatorEstimate.mockReset().mockResolvedValue(answer(estimate()));
});
afterEach(cleanup);

describe('opening the view', () => {
  it('reads the categories once and sends no estimate', async () => {
    renderView();
    await ready();
    expect(client.fetchCalculatorCategories).toHaveBeenCalledTimes(1);
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
    expect(screen.getByText(m.result.idle)).toBeTruthy();
  });

  it('offers every category in the answer order, models as text, no model control', async () => {
    renderView();
    await ready();
    const group = screen.getByRole('group', { name: m.inputs.categoriesLabel });
    const names = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual([
      'EconomyFor example: model-a',
      'BalancedFor example: model-b, model-c',
      'FlagshipFor example: model-d',
    ]);
    // Nothing selects a model: the only controls in the group are the categories.
    expect(within(group).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(group).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('shows a category with no live model as unavailable and keeps the others usable', async () => {
    client.fetchCalculatorCategories.mockResolvedValue(
      answer(
        categories({
          categories: [
            { key: 'economy', models: [] },
            { key: 'balanced', models: [{ id: 'model-b', provider: 'p' }] },
          ],
        }),
      ),
    );
    renderView();
    const economy = await screen.findByRole('button', { name: /Economy/ });
    expect((economy as HTMLButtonElement).disabled).toBe(true);
    expect(within(economy).getByText(m.categories.empty)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Balanced/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('renders a failed categories read distinctly, with a retry that re-reads', async () => {
    client.fetchCalculatorCategories.mockResolvedValueOnce({ kind: 'failed' });
    renderView();
    await screen.findByText(m.categories.failed);
    expect(
      (screen.getByRole('button', { name: m.inputs.submit }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: enMessages.billing.states.retry }));
    await ready();
    expect(client.fetchCalculatorCategories).toHaveBeenCalledTimes(2);
  });

  it('shows the loading line while the categories are in flight', () => {
    client.fetchCalculatorCategories.mockReturnValue(new Promise(() => {}));
    renderView();
    expect(screen.getByText(enMessages.billing.states.loading)).toBeTruthy();
  });
});

describe('picking categories', () => {
  it('lets one, two and three be sent and stops a fourth', async () => {
    client.fetchCalculatorCategories.mockResolvedValue(
      answer(
        categories({
          categories: [
            ...categories().categories,
            { key: 'extra', models: [{ id: 'model-e', provider: 'p' }] },
          ],
        }),
      ),
    );
    renderView();
    await ready();
    pick(/Economy/);
    pick(/Balanced/);
    pick(/Flagship/);
    expect((screen.getByRole('button', { name: /Extra/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // A chosen one can still be removed, which re-opens the fourth.
    pick(/Flagship/);
    expect((screen.getByRole('button', { name: /Extra/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('sends exactly the door body: the range, the picked keys and the shared cadence', async () => {
    renderView({ cadence: 'monthly' });
    await ask('40', '60', [/Flagship/, /Balanced/]);
    await screen.findByTestId('calculator-credits');
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledWith('org1', {
      itemsPerMonth: { low: 40, high: 60 },
      categories: ['flagship', 'balanced'],
      cadence: 'monthly',
    });
  });
});

describe('refusals before any request', () => {
  it.each([
    ['', '', m.errors.rangeEmpty],
    ['10', '', m.errors.rangeEmpty],
    ['abc', '5', m.errors.rangeInvalid],
    ['1.5', '5', m.errors.rangeInvalid],
    ['-3', '5', m.errors.rangeInvalid],
    ['50', '20', m.errors.rangeOrder],
  ])('refuses low=%j high=%j with its own sentence', async (low, high, sentence) => {
    renderView();
    await ask(low, high, [/Balanced/]);
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
  });

  it('refuses no category, inline, and sends nothing', async () => {
    renderView();
    await ask('10', '20', []);
    expect(await screen.findByText(m.errors.categoryMissing)).toBeTruthy();
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
  });
});

describe('the regular arm', () => {
  it.each([
    ['annual', 'billed annually · $2,400 / yr'],
    ['monthly', '$300 / mo'],
  ] as const)('prices Max ×2 from the catalog on %s', async (cadence, price) => {
    renderView({ cadence });
    await ask();
    expect((await screen.findByTestId('calculator-plan')).textContent).toContain('Max ×2');
    expect(screen.getByTestId('calculator-price').textContent).toBe(price);
    expect(screen.queryByTestId('calculator-larger')).toBeNull();
    expect(screen.queryByText(/Max ×2 plus/)).toBeNull();
  });

  it('prints the split the answer carries, the range and the caveat — no single figure', async () => {
    renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    expect(screen.getByText('Split evenly across Balanced and Flagship — 50% each.')).toBeTruthy();
    expect(screen.getByTestId('calculator-credits').textContent).toBe('11,000 – 44,000');
    expect(screen.getByText(m.result.estimateCaveat)).toBeTruthy();
    expect(screen.getByText(m.result.perOrg)).toBeTruthy();
  });

  it('words one category as carrying the whole estimate', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({ split: { count: 1, categories: [{ key: 'balanced', weight: 1, models: [] }] } }),
      ),
    );
    renderView();
    await ask('1', '2', [/Balanced/]);
    expect(
      await screen.findByText('One category, so the whole estimate sits on Balanced.'),
    ).toBeTruthy();
  });

  it('prints a third each for three categories', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          split: {
            count: 3,
            categories: ['economy', 'balanced', 'flagship'].map((key) => ({
              key,
              weight: 1 / 3,
              models: [],
            })),
          },
        }),
      ),
    );
    renderView();
    await ask('1', '2', [/Economy/, /Balanced/, /Flagship/]);
    expect(
      await screen.findByText('Split evenly across Economy, Balanced, and Flagship — 33% each.'),
    ).toBeTruthy();
  });

  it('prints the seat line as its own row, from the catalog, with no total', async () => {
    renderView();
    await ask();
    const seat = await screen.findByTestId('calculator-seat');
    expect(seat.textContent).toContain('Every AI plan includes 1 Motir seat at no charge.');
    expect(seat.textContent).toContain(
      `Further seats: $${BILLING_CATALOG.seatPlan.prices.annual.amountUsd} per user, per year.`,
    );
  });

  it('renders an open plan key by the answer’s own name and price, never a neighbour’s', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          recommendation: { planKey: 'brand_new', planName: 'Brand New', monthlyPriceUsd: 77 },
        }),
      ),
    );
    renderView();
    await ask();
    const plan = await screen.findByTestId('calculator-plan');
    expect(plan.textContent).toContain('Brand New');
    expect(screen.getByTestId('calculator-price').textContent).toBe('$77 / mo');
    expect(plan.textContent).not.toContain('Max');
  });

  it('shows a top-up as the answer’s two ends, only where one is carried', async () => {
    renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    expect(screen.queryByTestId('calculator-topup')).toBeNull();

    cleanup();
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          topUp: {
            low: { units: 0, credits: 0, priceUsd: 0 },
            high: { units: 2, credits: 2_000, priceUsd: 10 },
          },
        }),
      ),
    );
    renderView();
    await ask();
    expect((await screen.findByTestId('calculator-topup')).textContent).toContain(
      '0 credits – 2,000 credits',
    );
  });

  it('names no plan on a top-up-only answer and says the seat comes with an AI plan', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          recommendation: { planKey: null, planName: null, monthlyPriceUsd: 0 },
          topUp: {
            low: { units: 1, credits: 1_000, priceUsd: 5 },
            high: { units: 2, credits: 2_000, priceUsd: 10 },
          },
        }),
      ),
    );
    const handles = renderView();
    await ask();
    expect(await screen.findByText(m.result.topupOnly)).toBeTruthy();
    expect(screen.getByTestId('calculator-seat').textContent).toBe(m.seat.noPlan);
    expect(screen.queryByTestId('calculator-plan')).toBeNull();
    expect(screen.queryByRole('button', { name: m.result.goToPlan })).toBeNull();
    expect(handles.goToPlan).not.toHaveBeenCalled();
  });

  it('leads to the plans view with that plan, and starts nothing', async () => {
    const handles = renderView();
    await ask();
    fireEvent.click(await screen.findByRole('button', { name: m.result.goToPlan }));
    expect(handles.goToPlan).toHaveBeenCalledWith('max_x2');
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(1);
  });
});

describe('the larger-pool arm', () => {
  it('renders the answer’s own plan and price with no catalog entry and no top-up statement', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    const handles = renderView();
    await ask();
    const block = await screen.findByTestId('calculator-larger');
    expect(block.textContent).toContain(m.result.largerPoolLabel);
    expect(block.textContent).toContain('Pool X');
    expect(block.textContent).toContain('$555 / mo');
    expect(block.textContent).toContain(m.result.largerPlanEstimate);
    expect(screen.getByText(m.result.estimateCaveat)).toBeTruthy();
    // Exclusivity: nothing of the top-of-ladder world.
    expect(screen.queryByTestId('calculator-plan')).toBeNull();
    expect(screen.queryByTestId('calculator-topup')).toBeNull();
    expect(screen.queryByText(/largest regular plan's/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: m.result.goToPlan }));
    expect(handles.goToPlan).toHaveBeenCalledWith('pool_x');
  });

  it('counts the included seat from the catalog constant', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView();
    await ask();
    expect((await screen.findByTestId('calculator-seat')).textContent).toContain(
      `includes ${INCLUDED_TRACKER_SEATS_PER_AI_PLAN} Motir seat`,
    );
  });

  it('adds the upgrade line for an org holding a live paid plan, with no figure', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView({ data: status({ tierKey: 'pro', active: true }) });
    await ask();
    const note = await screen.findByText(m.result.upgradeNote);
    expect(note.textContent).not.toMatch(/\$\d/);
  });

  it('has no upgrade line for an org with no paid plan', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView();
    await ask();
    await screen.findByTestId('calculator-larger');
    expect(screen.queryByText(m.result.upgradeNote)).toBeNull();
  });
});

describe('above the ladder with no larger pool', () => {
  it('says so with the answer’s ceiling and shows the top-up range, in words the larger arm lacks', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(above()));
    renderView();
    await ask();
    expect(
      await screen.findByText(
        "That is more than the largest regular plan's 60,000 credits a month, and no larger pool is available right now, so the excess is met with credit top-ups.",
      ),
    ).toBeTruthy();
    expect((await screen.findByTestId('calculator-plan')).textContent).toContain('Max ×2');
    expect(screen.getByTestId('calculator-topup').textContent).toContain(
      '1,000 credits – 101,000 credits',
    );
    expect(screen.queryByTestId('calculator-larger')).toBeNull();
  });

  it('shows the upgrade line when the held plan is below the plan named', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(above()));
    renderView({ data: status({ tierKey: 'pro', active: true }) });
    await ask();
    expect(await screen.findByText(m.result.upgradeNote)).toBeTruthy();
  });

  it('shows no upgrade line to an org already on the plan the answer names', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(above()));
    renderView({ data: status({ tierKey: 'max_x2', active: true }) });
    await ask();
    await screen.findByTestId('calculator-plan');
    expect(screen.queryByText(m.result.upgradeNote)).toBeNull();
  });
});

describe('the door’s other outcomes', () => {
  it('words unavailable and failed differently, with a retry that re-asks and no number', async () => {
    client.fetchCalculatorEstimate.mockResolvedValueOnce({ kind: 'unavailable' });
    renderView();
    await ask();
    expect(await screen.findByText(m.errors.unavailable)).toBeTruthy();
    expect(screen.queryByText(m.errors.failed)).toBeNull();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();

    client.fetchCalculatorEstimate.mockResolvedValueOnce({ kind: 'failed' });
    fireEvent.click(screen.getByRole('button', { name: enMessages.billing.states.retry }));
    expect(await screen.findByText(m.errors.failed)).toBeTruthy();
    expect(screen.queryByText(m.errors.unavailable)).toBeNull();
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(2);
  });

  it('renders a refusal that names the range on the range, with no estimate', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue({
      kind: 'refused',
      field: 'itemsPerMonth.low',
    });
    renderView();
    await ask();
    expect(await screen.findByText(m.errors.rangeInvalid)).toBeTruthy();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
  });

  it('renders a refusal that names the categories as the category cap', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue({ kind: 'refused', field: 'categories' });
    renderView();
    await ask();
    expect(await screen.findByText(m.errors.tooManyCategories)).toBeTruthy();
  });

  it('renders a refusal with no field as the failed state, never the server’s words', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue({ kind: 'refused', field: null });
    renderView();
    await ask();
    expect(await screen.findByText(m.errors.failed)).toBeTruthy();
  });

  it('renders an empty-category answer per category, with no figure', async () => {
    const empty: CalculatorEmptyCategoryDTO = {
      version: 2,
      kind: 'empty_category',
      categoryRuleVersion: 'rule-1',
      categories: ['economy'],
    };
    client.fetchCalculatorEstimate.mockResolvedValue(answer(empty));
    renderView();
    await ask();
    const result = await screen.findByTestId('calculator-result');
    await waitFor(() => expect(result.textContent).toContain(m.categories.empty));
    expect(result.textContent).toContain('Economy');
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
    expect(screen.queryByText(m.errors.unavailable)).toBeNull();
  });
});

describe('editing clears, it does not re-ask', () => {
  it('returns to not-yet-asked on a range edit, keeping the inputs', async () => {
    renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    type(m.inputs.highLabel, '70');
    expect(screen.getByText(m.result.idle)).toBeTruthy();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
    expect((screen.getByLabelText(m.inputs.lowLabel) as HTMLInputElement).value).toBe('40');
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(1);
  });

  it('clears on a category change and on a cadence change, asking nothing', async () => {
    const handles = renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    pick(/Economy/);
    expect(screen.getByText(m.result.idle)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
    await screen.findByTestId('calculator-credits');
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(handles.onCadence).toHaveBeenCalledWith('monthly');
    expect(screen.getByText(m.result.idle)).toBeTruthy();
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(2);
  });

  it('shows loading while asking, and a late answer never lands under newer inputs', async () => {
    let release: (o: CalculatorOutcome<CalculatorEstimateDTO>) => void = () => {};
    client.fetchCalculatorEstimate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderView();
    await ask();
    expect(await screen.findByText(m.result.loading)).toBeTruthy();
    type(m.inputs.highLabel, '99');
    expect(screen.getByText(m.result.idle)).toBeTruthy();
    await act(async () => release(answer(estimate())));
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
    expect(screen.getByText(m.result.idle)).toBeTruthy();
  });
});

describe('in 中文', () => {
  it('renders the same figures with no raw message key', async () => {
    const zh = (await import('@/messages/zh.json')).default as Record<string, unknown>;
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    render(
      <CalculatorView
        orgId="org1"
        orgName="Acme"
        data={status()}
        cadence="annual"
        onCadence={() => {}}
        back={() => {}}
        goToPlan={() => {}}
      />,
      { locale: 'zh', messages: zh },
    );
    const low = await screen.findByLabelText('下限');
    fireEvent.change(low, { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('上限'), { target: { value: '60' } });
    fireEvent.click(await screen.findByRole('button', { name: /Balanced/ }));
    fireEvent.click(screen.getByRole('button', { name: '估算积分' }));
    const block = await screen.findByTestId('calculator-larger');
    expect(block.textContent).toContain('更大的积分池');
    expect(block.textContent).toContain('$555');
    expect(document.body.textContent).not.toMatch(/billing\.calculator/);
  });
});
