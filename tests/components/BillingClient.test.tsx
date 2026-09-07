// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import { BillingClient } from '@/app/(authed)/settings/organization/billing/_components/BillingClient';

// Component test for the 8.1.7 billing settings surface (design/billing panels
// 1–6, 8). Proves the island's behaviour against the 8.1.6 boundary: the
// loading→render path, the error + member-gate states, and the
// change-plan → Stripe Checkout redirect (the CTA POSTs the catalog price and
// the browser is sent to the returned hosted URL), plus the annual/monthly
// cadence reprice. The billing GET/POST routes (fetch) are stubbed; the routes'
// own behaviour is covered against real Postgres in the 8.1.6 service tests.

const hrefSetter = vi.fn();

// ③ Motir CI (MOTIR-1903) — the entitlement state as `getEntitlementState`
// returns it. The default is a healthy, INSIDE-the-pool org: the fixture is
// never an always-null optional, because a CI figure threaded as one renders
// nothing while every assertion below still passes.
function ciState(over: Partial<CiEntitlementStateDTO> = {}): CiEntitlementStateDTO {
  return {
    applicable: true,
    organizationId: 'org1',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    memberCount: 6,
    poolMinutes: 1800,
    floorApplied: false,
    consumedMinutes: 1240,
    remainingMinutes: 560,
    overageMinutes: 0,
    chargedCredits: 0,
    balance: 4420,
    state: 'within_allowance',
    ...over,
  };
}

function withCi(over: Partial<CiEntitlementStateDTO>, canManage = true): BillingStatusDTO {
  return {
    ...activeStandard(),
    access: canManage
      ? { role: 'owner', canManageBilling: true }
      : { role: 'admin', canManageBilling: false },
    ci: ciState(over),
  };
}

function renderWithBody(body: BillingStatusDTO) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
  renderClient();
}

function activeStandard(): BillingStatusDTO {
  return {
    organizationId: 'org1',
    access: { role: 'owner', canManageBilling: true },
    isMeta: false,
    internalBilling: false,
    // ④ The Motir Search line's figures (MOTIR-4555 carries them; MOTIR-4557
    // renders them). The default is a zero month, so the base fixture exercises
    // the `nothing_to_bill` shape and the spend cases opt in explicitly.
    search: { totalSpend: 0, monthSpend: 0 },
    motir: { scaledTrackerSubscription: null, aiIncludedSeat: false },
    motirAi: {
      tier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
      balance: 1420,
      subscription: {
        status: 'active',
        currentPeriodEnd: '2026-07-01T00:00:00.000Z',
        priceId: 'standard_pool_annual',
        planTier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
      },
    },
    ci: ciState(),
    catalog: BILLING_CATALOG,
  };
}

function renderClient() {
  return render(
    <ToastProvider>
      <BillingClient orgId="org1" orgName="Acme" memberCount={6} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  hrefSetter.mockClear();
  // A writable location stub: the component reads `.search` on mount and assigns
  // `.href` to redirect to Stripe — capture the assignment instead of navigating.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return 'http://localhost/settings/organization/billing';
      },
      set href(v: string) {
        hrefSetter(v);
      },
      search: '',
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BillingClient', () => {
  it('renders both billed lines on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(activeStandard()), { status: 200 })),
    );
    renderClient();

    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
    // ① Motir line + ② Motir AI line both present.
    expect(screen.getByRole('heading', { name: 'Motir', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeTruthy();
    // The active tier + status render.
    expect(screen.getByText('Standard')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  // ⚠️ THIS CASE IS INVERTED, NOT DELETED (Story MOTIR-4337 · MOTIR-4572). It
  // asserted that a META org rendered ONE read-only card and no storefront —
  // *"no upgrade / change-plan / seats buttons"*. That treatment is the defect
  // the story removes: the organization with the most product usage was the only
  // one that could not see the screens. So the same fixture now asserts the
  // opposite, which is the only way a later change back would be caught.
  it('renders the ORDINARY storefront for an internal-billing org, plus a label', async () => {
    const internal = { ...activeStandard(), internalBilling: true };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(internal), { status: 200 })),
    );
    renderClient();

    // Every view a paying org gets — the lines, the headings, the CTAs.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeTruthy(),
    );
    expect(screen.getByRole('heading', { name: 'Motir', level: 2 })).toBeTruthy();
    // The two CTAs the old treatment named in its own assertion as ABSENT.
    expect(screen.getByRole('button', { name: 'Upgrade Motir' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change plan' })).toBeTruthy();
    // A LABEL beside them, and nothing suppressed by it.
    expect(screen.getByText('Internal billing')).toBeTruthy();
  });

  // ⚠️ THE CTAs MUST ALSO ARRIVE SOMEWHERE. A storefront whose buttons render
  // and lead nowhere would pass the case above and fail the story — so each of
  // the two views the home screen can reach is entered over the SAME classified
  // fixture, which is the whole of what AC 3 means by "plans and seats".
  it('an internal-billing org reaches the PLANS view and the SEATS view', async () => {
    const internal = { ...activeStandard(), internalBilling: true };

    renderWithBody(internal);
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
    await waitFor(() => expect(screen.getByText('Motir AI — plans & subscription')).toBeTruthy());

    cleanup();
    vi.unstubAllGlobals();

    renderWithBody(internal);
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade Motir' }));
    await waitFor(() => expect(screen.getByText('Scale up Motir')).toBeTruthy());
  });

  it('shows the error state when the boundary fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 502 })),
    );
    renderClient();
    await waitFor(() => expect(screen.getByText("Couldn't load billing")).toBeTruthy());
  });

  it('shows the member gate on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    renderClient();
    await waitFor(() =>
      expect(screen.getByText('Billing is managed by your org owner')).toBeTruthy(),
    );
  });

  it('change-plan → Pro Checkout redirect, and the cadence toggle reprices', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/billing')) {
        return new Response(JSON.stringify(activeStandard()), { status: 200 });
      }
      // The checkout POST → return a hosted Stripe URL.
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ url: 'https://stripe.test/checkout/abc' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderClient();
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());

    // Enter the AI plans screen.
    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
    await waitFor(() => expect(screen.getByText('Motir AI — plans & subscription')).toBeTruthy());

    // Annual is the default cadence → Pro shows its per-month equivalent ($600/12).
    expect(screen.getByText('$50 / mo')).toBeTruthy();

    // Toggle to Monthly → Pro reprices to its monthly fee.
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    await waitFor(() => expect(screen.getByText('$75 / mo')).toBeTruthy());

    // Back to annual, then start checkout on Pro → POST + redirect to Stripe.
    fireEvent.click(screen.getByRole('button', { name: 'Annual' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));

    await waitFor(() =>
      expect(hrefSetter).toHaveBeenCalledWith('https://stripe.test/checkout/abc'),
    );
    const checkoutCall = fetchMock.mock.calls.find(
      ([u]) => typeof u === 'string' && u.endsWith('/checkout'),
    );
    expect(checkoutCall).toBeTruthy();
    expect(JSON.parse((checkoutCall![1] as RequestInit).body as string)).toEqual({
      priceLookupKey: 'pro_pool_annual',
    });
  });

  it('seats screen: Monthly/Annual toggle reprices and drives the Checkout price (8.1.16)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/billing')) {
        return new Response(JSON.stringify(activeStandard()), { status: 200 });
      }
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ url: 'https://stripe.test/checkout/seat' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderClient();
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());

    // Enter the seats (scale-up) screen.
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade Motir' }));
    await waitFor(() => expect(screen.getByText('Scale up Motir')).toBeTruthy());

    // Default annual → 6 members × $40/yr = $240 / yr.
    expect(screen.getByText('6 × $40/yr = $240 / yr')).toBeTruthy();

    // Toggle to Monthly → reprices to 6 × $5/mo = $30 / mo.
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    await waitFor(() => expect(screen.getByText('6 × $5/mo = $30 / mo')).toBeTruthy());

    // Start Checkout on the monthly cadence → POSTs the MONTHLY seat price.
    fireEvent.click(screen.getByRole('button', { name: /Continue to Checkout/ }));
    await waitFor(() =>
      expect(hrefSetter).toHaveBeenCalledWith('https://stripe.test/checkout/seat'),
    );
    const checkoutCall = fetchMock.mock.calls.find(
      ([u]) => typeof u === 'string' && u.endsWith('/checkout'),
    );
    expect(checkoutCall).toBeTruthy();
    expect(JSON.parse((checkoutCall![1] as RequestInit).body as string)).toEqual({
      priceLookupKey: 'tracker_monthly',
    });
  });

  it('top-up: the SELECTED bundle reaches the checkout POST as `quantity` (MOTIR-2949)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/billing')) {
        return new Response(JSON.stringify(activeStandard()), { status: 200 });
      }
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ url: 'https://stripe.test/checkout/topup' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderClient();
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());

    // The top-up card lives on the AI plans screen, below the tier ladder.
    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
    await waitFor(() => expect(screen.getByText('Top up credits')).toBeTruthy());

    // 1× is the default — pick the 10× bundle ($10 × 10 = $100 for 10,000).
    fireEvent.click(screen.getByRole('button', { name: /10,000 credits/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Buy 10,000 credits/ })).toBeTruthy(),
    );

    // The label PROMISES 10,000 credits for $100 — the POST must carry the same
    // order, or Stripe charges $10 for 1,000 (the bug this test reproduces).
    fireEvent.click(screen.getByRole('button', { name: /Buy 10,000 credits — \$100/ }));
    await waitFor(() =>
      expect(hrefSetter).toHaveBeenCalledWith('https://stripe.test/checkout/topup'),
    );
    const checkoutCall = fetchMock.mock.calls.find(
      ([u]) => typeof u === 'string' && u.endsWith('/checkout'),
    );
    expect(checkoutCall).toBeTruthy();
    expect(JSON.parse((checkoutCall![1] as RequestInit).body as string)).toEqual({
      priceLookupKey: 'credit_topup',
      quantity: 10,
    });
  });

  it('top-up: the DEFAULT 1× bundle sends quantity 1 (MOTIR-2949)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/billing')) {
        return new Response(JSON.stringify(activeStandard()), { status: 200 });
      }
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ url: 'https://stripe.test/checkout/topup1' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderClient();
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
    await waitFor(() => expect(screen.getByText('Top up credits')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Buy 1,000 credits — \$10/ }));
    await waitFor(() =>
      expect(hrefSetter).toHaveBeenCalledWith('https://stripe.test/checkout/topup1'),
    );
    const checkoutCall = fetchMock.mock.calls.find(
      ([u]) => typeof u === 'string' && u.endsWith('/checkout'),
    );
    expect(JSON.parse((checkoutCall![1] as RequestInit).body as string)).toEqual({
      priceLookupKey: 'credit_topup',
      quantity: 1,
    });
  });

  it('no longer renders the redundant cloud-only note (8.1.16)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(activeStandard()), { status: 200 })),
    );
    renderClient();
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
    expect(screen.queryByText(/Cloud-only/)).toBeNull();
  });

  it('four-tier storefront: no Starter, paid cards show the bundled Motir seat + use-case (8.1.17)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(activeStandard()), { status: 200 })),
    );
    renderClient();
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
    await waitFor(() => expect(screen.getByText('Motir AI — plans & subscription')).toBeTruthy());

    // Starter is gone — its CTA never renders.
    expect(screen.queryByRole('button', { name: 'Choose Starter' })).toBeNull();
    // Paid cards carry the bundled Motir seat; Free states the absence (never "tracker").
    expect(
      screen.getAllByText('+ 1 Motir seat · work items uncapped').length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('No Motir seat · 250-item cap')).toBeTruthy();
    expect(screen.queryByText(/tracker seat/i)).toBeNull();
    // Per-tier use-case copy + the cumulative "Everything in {prev}" lead render.
    expect(screen.getByText('Detailed planning, plus real agent work.')).toBeTruthy();
    expect(screen.getByText('Everything in Standard, plus')).toBeTruthy();
  });

  it('SeatsView surfaces the bundled Motir seat when the org holds a paid AI plan (8.1.25)', async () => {
    const withAiSeat = {
      ...activeStandard(),
      motir: { scaledTrackerSubscription: null, aiIncludedSeat: true },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(withAiSeat), { status: 200 })),
    );
    renderClient();
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
    // Enter the seats screen (Motir line → Upgrade Motir).
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade Motir' }));
    await waitFor(() => expect(screen.getByText('Scale up Motir')).toBeTruthy());
    // The included-seat note renders, netting one off the billed count (6 → 5).
    expect(screen.getByText(/includes 1 Motir seat/i)).toBeTruthy();
    expect(screen.getByText(/billed for 5 additional/i)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ The Motir CI line (MOTIR-1903 · design/billing "Amendment 2026-07-30").
// One test per drawn state, plus the two rules a reviewer cannot see in a
// screenshot: the paused card is HOISTED above ① and ②, and the not-applicable
// cases render no line at all.
describe('BillingClient — the Motir CI line', () => {
  it('renders the line in place, with the used/included figures and the seat derivation', async () => {
    renderWithBody(withCi({}));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    expect(screen.getByText('Included')).toBeTruthy();
    expect(screen.getByText('1,240 of 1,800 minutes')).toBeTruthy();
    expect(screen.getByText('560 minutes left')).toBeTruthy();
    // The pool is EXPLAINED, not asserted — 300 × 6 seats.
    expect(screen.getByText('Your included minutes: 300 min × 6 seats')).toBeTruthy();
    // The reset date is stated AND distinguished from the AI renewal (§4.5).
    expect(screen.getByText(/Resets Aug 1, 2026/)).toBeTruthy();
    expect(screen.getByText(/not the same date as your Motir AI renewal/)).toBeTruthy();
  });

  it('names the FLOOR in the derivation for a small org', async () => {
    renderWithBody(
      withCi({
        memberCount: 2,
        poolMinutes: 1000,
        floorApplied: true,
        consumedMinutes: 240,
        remainingMinutes: 760,
      }),
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());
    expect(screen.getByText('Your included minutes: 1,000 minute minimum')).toBeTruthy();
    expect(screen.queryByText(/min × 2 seats/)).toBeNull();
  });

  it('shows drawing-on-credits as a VISIBLE state that blocks nothing, with CI credits distinct from AI', async () => {
    renderWithBody(
      withCi({
        state: 'drawing_on_credits',
        consumedMinutes: 2220,
        remainingMinutes: 0,
        overageMinutes: 420,
        chargedCredits: 420,
      }),
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    expect(screen.getByText('Drawing on credits')).toBeTruthy();
    expect(screen.getByText('420 minutes over')).toBeTruthy();
    expect(screen.getByText(/420 credits drawn this period/)).toBeTruthy();
    expect(screen.getByText(/Nothing is blocked/)).toBeTruthy();
    // CI's spend is its own figure — the AI line's balance is NOT restated here.
    expect(screen.getByText('1,420 of 2,000 credits left')).toBeTruthy();
  });

  it('renders the zero-consumption case as a statement, never a "0 of 1,800" meter', async () => {
    renderWithBody(withCi({ consumedMinutes: 0, remainingMinutes: 1800 }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    expect(screen.getByText('Nothing to bill')).toBeTruthy();
    expect(screen.getByText(/All of this project's repositories are your own/)).toBeTruthy();
    expect(screen.queryByText('0 of 1,800 minutes')).toBeNull();
  });

  it('EXHAUSTED + admin: the two-option decision, both peers, neither a primary default', async () => {
    renderWithBody(
      withCi({
        state: 'ci_credits_exhausted',
        consumedMinutes: 2410,
        remainingMinutes: 0,
        overageMinutes: 610,
        chargedCredits: 610,
        balance: 0,
      }),
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    expect(screen.getByText('CI paused')).toBeTruthy();
    expect(screen.getByText('CI is paused — your credits ran out.')).toBeTruthy();
    expect(screen.getByText('610 credits drawn')).toBeTruthy();

    // Both options render, and each states its REAL cost.
    const addCredits = screen.getByRole('button', { name: 'Add credits' });
    const move = screen.getByRole('link', { name: /Move repositories/ });
    expect(screen.getByText(/at most 15/)).toBeTruthy();
    expect(screen.getByText(/re-installing the Motir app/)).toBeTruthy();
    // Neither is dressed as THE answer — no primary accent fill on either peer.
    expect(addCredits.dataset['variant']).toBe('secondary');
    expect(addCredits.className).not.toContain('bg-(--el-accent)');
    expect(move.className).not.toContain('bg-(--el-accent)');
    // The takeover is never hidden and never gated on a stored GitHub identity.
    expect(move.getAttribute('href')).toBe('/settings/project/repositories');

    // Add credits routes to the shipped top-up screen, not a second checkout.
    fireEvent.click(addCredits);
    await waitFor(() => expect(screen.getByText('Motir AI — plans & subscription')).toBeTruthy());
  });

  it('EXHAUSTED + a viewer who cannot manage billing: an alert that routes without naming, and NO dead control', async () => {
    renderWithBody(
      withCi(
        {
          state: 'ci_credits_exhausted',
          consumedMinutes: 2410,
          remainingMinutes: 0,
          overageMinutes: 610,
          chargedCredits: 610,
          balance: 0,
        },
        false,
      ),
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    expect(screen.getByText('CI is paused — this organization is out of credits.')).toBeTruthy();
    expect(screen.getByText(/until an organization owner adds credits/)).toBeTruthy();
    expect(screen.getByText(/There is no action for you here/)).toBeTruthy();
    // A control this user cannot use is never rendered — not even disabled.
    expect(screen.queryByRole('button', { name: 'Add credits' })).toBeNull();
  });

  it('HOISTS the paused CI card above the Motir and Motir AI lines (the measured ordering rule)', async () => {
    renderWithBody(
      withCi({
        state: 'ci_credits_exhausted',
        consumedMinutes: 2410,
        remainingMinutes: 0,
        overageMinutes: 610,
        chargedCredits: 610,
        balance: 0,
      }),
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    const order = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((x) => x === 'Motir' || x === 'Motir AI' || x === 'Motir CI');
    expect(order).toEqual(['Motir CI', 'Motir', 'Motir AI']);
  });

  it('keeps the CI card THIRD when it is not paused', async () => {
    renderWithBody(withCi({}));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    const order = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((x) => x === 'Motir' || x === 'Motir AI' || x === 'Motir CI');
    expect(order).toEqual(['Motir', 'Motir AI', 'Motir CI']);
  });

  it('says the BALANCE is unavailable without turning it into exhaustion or a zero', async () => {
    renderWithBody(withCi({ balance: null }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy());

    expect(screen.getByText(/Your credit balance is temporarily unavailable/)).toBeTruthy();
    // Still the healthy state — a transport blip is not "out of credits".
    expect(screen.getByText('Included')).toBeTruthy();
    expect(screen.queryByText('CI paused')).toBeNull();
    // And the minutes half stays accurate.
    expect(screen.getByText('1,240 of 1,800 minutes')).toBeTruthy();
  });

  it('renders NO CI line when the entitlement does not apply (self-host / no provisioning org)', async () => {
    renderWithBody(
      withCi({
        applicable: false,
        state: 'bypassed',
        poolMinutes: 0,
        consumedMinutes: 0,
        remainingMinutes: 0,
        memberCount: 0,
        balance: null,
      }),
    );
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());

    expect(screen.queryByRole('heading', { name: 'Motir CI' })).toBeNull();
    // The two shipped lines are untouched.
    expect(screen.getByRole('heading', { name: 'Motir', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeTruthy();
  });

  // ⚠️ INVERTED (MOTIR-4572), and this one carries the story's own amendment.
  // The CI line used to be HIDDEN for a meta org. It now RENDERS, in whatever
  // state `ciAllowanceService` returns — for a meta org that state is
  // `bypassed`, and showing it is the point. What did NOT change is the bypass
  // itself: `ci-minutes-allowance.md` §4.4 records that moooon B.V. pays its own
  // GitHub bill, so charging a CI minute Motir never paid for and then offsetting
  // it would put an invented figure on the very screen this story exists to make
  // honest.
  it('renders the CI line for an internal-billing org — hidden is what changed, not the bypass', async () => {
    renderWithBody({ ...withCi({}), internalBilling: true });
    await waitFor(() => expect(screen.getByText('Internal billing')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Motir CI' })).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ The Motir Search line (MOTIR-4557) — the fourth billed line.
//
// EXTENDS this suite rather than replacing it (AC 7): every assertion above, for
// the three shipped lines, is untouched and still runs.
//
// The line is figures and a cross-link — no button, no checkout, no owner-only
// affordance — so it takes no `canManage` and has no member variant of its own.
// The member test below asserts exactly that: the shipped permission split
// reaches it unchanged.
// ─────────────────────────────────────────────────────────────────────────────

function withSearch(
  search: BillingStatusDTO['search'],
  over: Partial<BillingStatusDTO> = {},
): BillingStatusDTO {
  return { ...activeStandard(), search, ...over };
}

describe('BillingClient — the Motir Search line', () => {
  it('renders as the FOURTH billed line, beside the three shipped ones', async () => {
    renderWithBody(withSearch({ totalSpend: 1204, monthSpend: 312 }));
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());

    expect(screen.getByRole('heading', { name: 'Motir Search', level: 2 })).toBeTruthy();
    // The three shipped lines are untouched by its arrival.
    expect(screen.getByRole('heading', { name: 'Motir', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Motir CI', level: 2 })).toBeTruthy();
  });

  it('shows both figures, labelled `credits` and never a currency (AC 4)', async () => {
    renderWithBody(withSearch({ totalSpend: 1204, monthSpend: 312 }));
    await waitFor(() => expect(screen.getByText('Spent this month')).toBeTruthy());

    expect(screen.getByText('Spent all time')).toBeTruthy();
    expect(screen.getByText('312')).toBeTruthy();
    expect(screen.getByText('1,204')).toBeTruthy();
    // The unit is the word, on both figures — a `$` anywhere on this line would
    // be the area's standing rule broken.
    expect(screen.getAllByText('credits').length).toBeGreaterThanOrEqual(2);
    const line = screen.getByRole('heading', { name: 'Motir Search', level: 2 }).closest('div');
    expect(line?.textContent ?? '').not.toContain('$');
  });

  it('renders NOTHING BILLED as a sentence, not as a zero figure', async () => {
    renderWithBody(withSearch({ totalSpend: 40, monthSpend: 0 }));
    await waitFor(() => expect(screen.getByText('No searches billed this month.')).toBeTruthy());

    // Deliberately NOT a "0 credits" figure: an org whose runs never search has
    // nothing wrong with it, and a zero drawn as a figure reads as if it did.
    expect(screen.queryByText('Spent this month')).toBeNull();
  });

  // ── AC 3's named assertion ─────────────────────────────────────────────────

  it('⚠️ renders UNAVAILABLE visibly differently from ZERO', async () => {
    renderWithBody(withSearch(null));
    await waitFor(() =>
      expect(
        screen.getByText(/Search figures aren’t available right now/, { exact: false }),
      ).toBeTruthy(),
    );

    // An em-dash carrying an accessible name — never a `0`, which would tell a
    // customer they were not charged.
    expect(screen.getAllByLabelText('Unavailable').length).toBe(2);
    expect(screen.getByText('Spent this month')).toBeTruthy();
    // And it is NOT the zero-month sentence.
    expect(screen.queryByText('No searches billed this month.')).toBeNull();

    // Now the genuinely-zero month, for contrast in the same suite.
    cleanup();
    renderWithBody(withSearch({ totalSpend: 0, monthSpend: 0 }));
    await waitFor(() => expect(screen.getByText('No searches billed this month.')).toBeTruthy());
    expect(screen.queryByLabelText('Unavailable')).toBeNull();
    expect(screen.queryByText(/aren’t available right now/, { exact: false })).toBeNull();
  });

  it('leaves the OTHER lines intact when only the search figures are missing', async () => {
    // A per-LINE treatment, never a page error: the search block is the only
    // thing absent, and ①②③ are fed by other reads.
    renderWithBody(withSearch(null));
    await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());

    expect(screen.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Motir CI', level: 2 })).toBeTruthy();
    expect(screen.queryByText(/We couldn’t load your billing/, { exact: false })).toBeNull();
  });

  // ── §5 — the overdraft banner, and the paused state that does not exist ────

  it('states that search keeps working at a zero balance — and shows no paused state', async () => {
    renderWithBody(
      withSearch(
        { totalSpend: 1204, monthSpend: 86 },
        {
          motirAi: { ...activeStandard().motirAi, balance: 0 },
        },
      ),
    );
    await waitFor(() =>
      expect(screen.getByText('Search keeps working when your balance runs out.')).toBeTruthy(),
    );

    // The figure is still shown — spend is still accruing, nothing is blocked.
    expect(screen.getByText('86')).toBeTruthy();
    // ⚠️ There is no "Search paused" pill, banner or decision anywhere. §5 makes
    // that a decision, not an omission, and building one would invent a state
    // the product does not have.
    expect(screen.queryByText(/Search paused/, { exact: false })).toBeNull();
  });

  it('shows no overdraft banner on a healthy balance', async () => {
    renderWithBody(withSearch({ totalSpend: 1204, monthSpend: 312 }));
    await waitFor(() => expect(screen.getByText('Spent this month')).toBeTruthy());
    expect(screen.queryByText('Search keeps working when your balance runs out.')).toBeNull();
  });

  // ── ⚠️ AC 3's META CASE, INVERTED (MOTIR-4572) ─────────────────────────────

  it('renders the search line for an internal-billing org', async () => {
    renderWithBody(withSearch({ totalSpend: 1204, monthSpend: 312 }, { internalBilling: true }));
    await waitFor(() => expect(screen.getByText('Internal billing')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Motir Search' })).toBeTruthy();
  });

  // ── AC 6 — the shipped role gating, unchanged ──────────────────────────────

  it('gives a plain ADMIN the same line as an owner — it has no control to gate', async () => {
    renderWithBody(
      withSearch(
        { totalSpend: 1204, monthSpend: 312 },
        {
          access: { role: 'admin', canManageBilling: false },
        },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Motir Search', level: 2 })).toBeTruthy(),
    );

    // Identical content to the owner's view: the figures, the rate line and the
    // cross-link. The line follows the panel's existing split rather than a rule
    // of its own, so a non-managing admin loses nothing on it.
    expect(screen.getByText('Spent this month')).toBeTruthy();
    expect(screen.getByText('312')).toBeTruthy();
    expect(screen.getByRole('link', { name: /See which runs spent it/ })).toBeTruthy();
  });

  it('links across to the usage dashboard rather than re-drawing the drill-down', async () => {
    renderWithBody(withSearch({ totalSpend: 1204, monthSpend: 312 }));
    const link = await screen.findByRole('link', { name: /See which runs spent it/ });
    expect(link.getAttribute('href')).toBe('/settings/organization/usage');
  });
});
