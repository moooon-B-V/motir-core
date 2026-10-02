// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { BillingHistorySlot } from '@/lib/services/platformOrgBillingService';
import { PaymentInvoicesCard } from '@/app/(admin)/admin/tenants/[orgId]/_components/PaymentInvoicesCard';

/**
 * The Billing tab's PAYMENT & INVOICES card (Story MOTIR-727 · MOTIR-7292, design D9):
 * the connected layout over a recorded fixture, the two other states, and no
 * mutation control in any of them.
 */

/** D9's own figures: •••• 4242, expires 08 / 28, three paid invoices. */
const RECORDED: BillingHistorySlot = {
  state: 'connected',
  paymentMethod: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 },
  invoices: [
    { id: 'in_3', month: '2026-09', status: 'paid', amountCents: 44_800, currency: 'usd' },
    { id: 'in_2', month: '2026-08', status: 'paid', amountCents: 44_120, currency: 'usd' },
    { id: 'in_1', month: '2026-07', status: 'paid', amountCents: 44_000, currency: 'usd' },
  ],
};

function renderCard(slot: BillingHistorySlot) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <PaymentInvoicesCard slot={slot} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('PaymentInvoicesCard', () => {
  it('connected: the payment-method row and the invoices table as D9 draws them, amounts exact from cents', () => {
    renderCard(RECORDED);
    const method = screen.getByTestId('payment-method');
    expect(method.textContent).toContain('•••• 4242');
    expect(method.textContent).toContain('expires 08 / 28');
    expect(within(method).getByText('Paid up')).toBeTruthy();

    const rows = within(screen.getByTestId('invoices')).getAllByRole('row').slice(1);
    expect(rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))).toEqual([
      ['Sep 2026', 'Paid', '$448.00'],
      ['Aug 2026', 'Paid', '$441.20'],
      ['Jul 2026', 'Paid', '$440.00'],
    ]);
  });

  it('an unpaid invoice drops the Paid up pill and shows its own status', () => {
    renderCard({
      ...RECORDED,
      invoices: [
        { id: 'in_9', month: '2026-10', status: 'open', amountCents: 1_999, currency: 'usd' },
      ],
    } as BillingHistorySlot);
    expect(screen.queryByText('Paid up')).toBeNull();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('$19.99')).toBeTruthy();
  });

  it.each([
    ['none', 'No invoices yet.'],
    ['unavailable', "The payment method and invoices can't be shown right now."],
  ] as const)('%s renders its own line and names no figure', (state, line) => {
    renderCard({ state } as BillingHistorySlot);
    const card = screen.getByTestId('payment-invoices');
    expect(card.getAttribute('data-state')).toBe(state);
    expect(card.textContent).toContain(line);
    expect(card.textContent).not.toMatch(/\$|••••/);
  });

  it('is read-only in every state: no link, no button', () => {
    for (const slot of [
      RECORDED,
      { state: 'none' },
      { state: 'unavailable' },
    ] as BillingHistorySlot[]) {
      const { container } = renderCard(slot);
      expect(container.querySelectorAll('a, button')).toHaveLength(0);
      cleanup();
    }
  });
});
