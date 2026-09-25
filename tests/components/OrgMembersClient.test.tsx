// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { OrgMembersClient } from '@/app/(authed)/settings/organization/members/_components/OrgMembersClient';
import type { OrgMemberPageDTO } from '@/lib/dto/organizations';
import type { SeatSummaryDTO } from '@/lib/dto/billing';

// Component test for the 8.1.14 members-admin seat/billing layer (design/org-
// admin members-billing). Proves the GATING the design turns on: a free org /
// self-host sees NO seat UI; a scaled org sees the seat band + the add cost note
// + the remove confirm; an admin gets the owner's controls (MOTIR-6311, design
// MOTIR-6303 panel 5); past_due shows the dunning variant. Plus the roster's
// org-role rules (panel 1): Admin / Member are the only roles offered, and the
// Owner's row is locked for every viewer. The members API (fetch) is stubbed.

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
    { userId: 'u-mara', name: 'Mara', email: 'mara@motir.co', role: 'admin', workspaces: [] },
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

// The viewer: the Owner (u-self) by default, or the Admin (u-mara).
function renderClient(seat: SeatSummaryDTO | null, viewer: 'owner' | 'admin' = 'owner') {
  return render(
    <ToastProvider>
      <OrgMembersClient
        orgId="org1"
        orgName="moooon"
        currentUserId={viewer === 'owner' ? 'u-self' : 'u-mara'}
        viewerIsOwner={viewer === 'owner'}
        initialPage={PAGE}
        seat={seat}
      />
    </ToastProvider>,
  );
}

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
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

  it('an ADMIN gets the Owner’s seat controls — Manage link, no View-only band (MOTIR-6311)', () => {
    // canManageBilling is true for an Admin since MOTIR-6305.
    renderClient(SCALED, 'admin');
    expect(screen.getByText('Scaled')).toBeTruthy();
    expect(screen.queryByText('View only')).toBeNull();
    expect(screen.queryByText(/managed by an owner/)).toBeNull();
    const manage = screen.getByText('Manage seats in Billing').closest('a');
    expect(manage?.getAttribute('href')).toBe('/settings/organization/billing');
  });

  it('a past_due org shows the dunning variant — Past due + Update payment', () => {
    renderClient({ ...SCALED, status: 'past_due' });
    expect(screen.getByText('Past due')).toBeTruthy();
    expect(screen.getByText('Update payment')).toBeTruthy();
    // No no-pay-wall note in the dunning state (active-only).
    expect(screen.queryByText('No pay-wall.')).toBeNull();
  });
});

describe('OrgMembersClient — the org roles on the roster (MOTIR-6311)', () => {
  const roleCombo = (name: string) =>
    screen.queryByRole('combobox', { name: `Organization role for ${name}` });

  it('as the OWNER: the Owner row is a static pill with the lock hint + Transfer link; no picker, no Remove', () => {
    renderClient(null, 'owner');
    expect(roleCombo('Zhu Yue')).toBeNull();
    expect(screen.getByText('Ownership moves only by transfer')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Transfer ownership' });
    expect(link.getAttribute('href')).toBe('/settings/organization#transfer-ownership');
    // Every other row keeps its picker and its Remove: Mara, Mo, Odie.
    expect(roleCombo('Mara')).toBeTruthy();
    expect(roleCombo('Mo')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(3);
  });

  it('the picker offers exactly Admin and Member, and says why Owner is absent', async () => {
    renderClient(null, 'owner');
    await click(roleCombo('Mo')!);
    const options = screen.getAllByRole('option').map((o) => o.textContent?.trim());
    expect(options).toEqual(['Admin', 'Member']);
    expect(
      screen.getByText('Owner isn’t offered here — ownership moves only by transfer.'),
    ).toBeTruthy();
  });

  it('as an ADMIN: the Owner row is locked too — no picker, no Remove, and no Transfer link', () => {
    renderClient(null, 'admin');
    expect(roleCombo('Zhu Yue')).toBeNull();
    expect(screen.getByText('Ownership moves only by transfer')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Transfer ownership' })).toBeNull();
    // The Admin's own row is static; Mo and Odie keep picker + Remove.
    expect(roleCombo('Mara')).toBeNull();
    expect(roleCombo('Mo')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('the Invite modal offers Admin and Member only', async () => {
    renderClient(null, 'admin');
    await click(screen.getByRole('button', { name: /Invite to organization/ }));
    await click(screen.getByRole('combobox', { name: 'Organization role' }));
    const options = screen
      .getAllByRole('option')
      .map((o) => o.getAttribute('aria-label') ?? o.textContent);
    expect(options.some((o) => /Owner/.test(o ?? ''))).toBe(false);
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('a stale role change refused ORG_OWNER_ONLY_BY_TRANSFER shows the design copy and reverts', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'ORG_OWNER_ONLY_BY_TRANSFER' }), { status: 409 }),
    ) as unknown as typeof fetch;
    renderClient(null, 'admin');
    await click(roleCombo('Mo')!);
    await click(screen.getByRole('option', { name: /Admin/ }));
    await waitFor(() =>
      expect(
        screen.getAllByText('Owner isn’t offered here — ownership moves only by transfer.').length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByText('Couldn’t change role')).toBeNull();
  });

  it('a stale Remove refused ORG_OWNER_MEMBERSHIP_LOCKED shows the design copy, not a generic failure', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'ORG_OWNER_MEMBERSHIP_LOCKED' }), { status: 409 }),
    ) as unknown as typeof fetch;
    renderClient(null, 'admin');
    await click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() =>
      expect(screen.getAllByText('Ownership moves only by transfer').length).toBeGreaterThan(1),
    );
    expect(screen.queryByText('Couldn’t remove member')).toBeNull();
  });
});
