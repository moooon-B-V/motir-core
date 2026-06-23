// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { OrgMembersClient } from '@/app/(authed)/settings/organization/members/_components/OrgMembersClient';
import type { OrgMemberPageDTO } from '@/lib/dto/organizations';
import type { SeatSummaryDTO } from '@/lib/dto/billing';

// Component test for the 8.1.14 members-admin seat/billing layer (design/org-
// admin members-billing). Proves the GATING the design turns on: a free org /
// self-host sees NO seat UI; a scaled org sees the seat band + the add cost note
// + the remove confirm; an admin sees it read-only; past_due shows the dunning
// variant. The members API (fetch) is stubbed — only the seat UI is under test.

// Radix Popover/Modal need APIs happy-dom omits (the CreateIssueModal recipe).
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const PAGE: OrgMemberPageDTO = {
  total: 6,
  nextCursor: null,
  members: [
    { userId: 'u-self', name: 'Zhu Yue', email: 'zhuyue@motir.co', role: 'owner', workspaces: [] },
    { userId: 'u-mo', name: 'Mo', email: 'mo@motir.co', role: 'member', workspaces: [] },
    { userId: 'u-odie', name: 'Odie', email: 'odie@motir.co', role: 'member', workspaces: [] },
  ],
};

// tracker_annual, 2030-01-01 renewal — owner view (canManageBilling true).
const SCALED: SeatSummaryDTO = {
  status: 'active',
  cadence: 'annual',
  perSeatUsd: 40,
  monthlyPerSeatUsd: 5,
  annualPerSeatUsd: 40,
  currentPeriodEnd: 1893456000,
  canManageBilling: true,
};

function renderClient(seat: SeatSummaryDTO | null) {
  return render(
    <ToastProvider>
      <OrgMembersClient
        orgId="org1"
        orgName="moooon"
        currentUserId="u-self"
        initialPage={PAGE}
        seat={seat}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OrgMembersClient — seat/billing layer', () => {
  it('a FREE org (seat=null) shows NO seat UI — the page is unchanged', () => {
    renderClient(null);
    expect(screen.queryByText('Scaled')).toBeNull();
    expect(screen.queryByText(/of 6 seats/)).toBeNull();
    expect(screen.queryByText('Manage seats in Billing')).toBeNull();
    // Remove stays a plain one-click button (no popover trigger).
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    expect(removes.length).toBeGreaterThan(0);
    expect(removes[0]!.getAttribute('aria-haspopup')).toBeNull();
  });

  it('a SCALED org (owner) shows the seat band, the price, the Scaled pill + Manage link', () => {
    renderClient(SCALED);
    expect(screen.getByText(/6 of 6 seats/)).toBeTruthy();
    expect(screen.getByText(/\$240 \/ yr/)).toBeTruthy();
    expect(screen.getByText('Scaled')).toBeTruthy();
    expect(screen.getByText(/saves \$120\/yr/)).toBeTruthy();
    const manage = screen.getByText('Manage seats in Billing').closest('a');
    expect(manage?.getAttribute('href')).toBe('/settings/organization/billing');
    // The no-pay-wall reassurance renders for the active scaled view.
    expect(screen.getByText('No pay-wall.')).toBeTruthy();
  });

  it('the Invite modal carries the prorated-charge cost note on a scaled org', async () => {
    renderClient(SCALED);
    fireEvent.click(screen.getByRole('button', { name: /Invite to organization/ }));
    await waitFor(() => expect(screen.getByText(/Adds a seat\./)).toBeTruthy());
    // From $240 (6) to $280 (7), charged now (always_invoice).
    expect(screen.getByText(/\$280 \/ yr \(7 seats\)/)).toBeTruthy();
    expect(screen.getByText(/charged now/)).toBeTruthy();
  });

  it('a scaled-org Remove opens a confirm popover disclosing the prorated credit', async () => {
    renderClient(SCALED);
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removes[0]!);
    await waitFor(() => expect(screen.getByText(/Remove .* from moooon\?/)).toBeTruthy());
    expect(screen.getByText(/Frees a seat/)).toBeTruthy();
    expect(screen.getByText(/no mid-term refund/)).toBeTruthy();
    // The DELETE has NOT fired — the popover discloses before acting.
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/members/'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('an ADMIN (canManageBilling false) sees the band READ-ONLY — View only, no Manage link', () => {
    renderClient({ ...SCALED, canManageBilling: false });
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.getByText('Scaled')).toBeTruthy();
    expect(screen.queryByText('Manage seats in Billing')).toBeNull();
  });

  it('a past_due org shows the dunning variant — Past due + Update payment', () => {
    renderClient({ ...SCALED, status: 'past_due' });
    expect(screen.getByText('Past due')).toBeTruthy();
    expect(screen.getByText('Update payment')).toBeTruthy();
    // No no-pay-wall note in the dunning state (active-only).
    expect(screen.queryByText('No pay-wall.')).toBeNull();
  });
});
