// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import { BillingClient } from '@/app/(authed)/settings/organization/billing/_components/BillingClient';

// Component test for the 8.1.7 billing settings surface (design/billing panels
// 1–6, 8). Proves the island's behaviour against the 8.1.6 boundary: the
// loading→render path, the error + member-gate states, and the
// change-plan → Stripe Checkout redirect (the CTA POSTs the catalog price and
// the browser is sent to the returned hosted URL), plus the annual/monthly
// cadence reprice. The billing GET/POST routes (fetch) are stubbed; the routes'
// own behaviour is covered against real Postgres in the 8.1.6 service tests.

const hrefSetter = vi.fn();

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
