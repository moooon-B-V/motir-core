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

  it('renders the Internal plan card (no upgrade CTAs) for the META org', async () => {
    const meta = { ...activeStandard(), isMeta: true };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(meta), { status: 200 })),
    );
    renderClient();

    await waitFor(() => expect(screen.getByText('Internal organization')).toBeTruthy());
    // The storefront + its CTAs are gone — no upgrade / change-plan / seats buttons.
    expect(screen.queryByRole('button', { name: 'Upgrade Motir' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Motir AI', level: 2 })).toBeNull();
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

  it('renders NO CI line for the META org (the Internal plan treatment stands alone)', async () => {
    renderWithBody({ ...withCi({}), isMeta: true });
    await waitFor(() => expect(screen.getByText('Internal organization')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Motir CI' })).toBeNull();
  });
});
