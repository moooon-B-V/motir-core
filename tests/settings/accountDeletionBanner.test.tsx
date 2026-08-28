// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { renderToHtml } from '../helpers/serverPageHarness';
import type { AccountDeletionRequestDTO } from '@/lib/dto/accountErasure';

// THE SCHEDULED STATE AND THE APP-WIDE CANCEL BANNER —
// `design/settings/account-data.mock.html` PANEL 5, design DECISION 4's TWO
// cancel doors (Story 8.4 · Subtask MOTIR-3704).
//
// Four properties, and the last two are the ones the card exists to pin:
//
//   1. THE BANNER IS APP-WIDE BY CONSTRUCTION, not per page. It is passed to
//      `AppLayout`'s `banner` slot from `app/(authed)/layout.tsx`, which is the
//      layout ABOVE every authed route — so "it appears on a page outside
//      account settings" is a property of WHERE IT IS MOUNTED, and that is
//      asserted here on a route that is not the pane. Asserting it only on the
//      pane would assert the one place it is not needed.
//   2. IT CARRIES THE ROW'S DATE, never a recomputed `now + 30 days`.
//   3. ⚠️ CANCELLING CLEARS IT WITHOUT A FULL RELOAD. The banner is a
//      SERVER-rendered shell slot, so `router.refresh()` re-runs its read and
//      the bar stops being rendered (CLAUDE.md's page-state contract, route 2);
//      its own button additionally removes it optimistically, because that
//      mutation fires from INSIDE the island (route 3). Both halves are
//      asserted, and `location.reload` is asserted NOT to be called — a stale
//      *"your account will be deleted"* bar after a successful cancel is the
//      exact failure this surface must not have.
//   4. THE PANE RENDERS ONE DELETION CARD OR THE OTHER, never both.

const cancelAccountDeletionAction = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const reload = vi.hoisted(() => vi.fn());

vi.mock('@/app/(authed)/_account-deletion-actions', () => ({ cancelAccountDeletionAction }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock('@/components/ui/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/Toast')>()),
  useToast: () => ({ toast }),
}));

const findOpenDeletion = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/accountDeletionService', () => ({
  accountDeletionService: { findOpenDeletion },
}));

// The rest of what the PANE reads, so the last describe can render the real
// route rather than read its source for a branch.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { previewAccountErasure } = vi.hoisted(() => ({ previewAccountErasure: vi.fn() }));
const { getLatestExportForUser } = vi.hoisted(() => ({ getLatestExportForUser: vi.fn() }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('@/lib/services/accountErasureService', () => ({
  accountErasureService: { previewAccountErasure },
}));
vi.mock('@/lib/services/dataExportService', () => ({
  dataExportService: { getLatestExportForUser },
}));
vi.mock('@/app/(authed)/settings/account/data/actions', () => ({
  requestDataExportAction: vi.fn(async () => ({ ok: true, started: true })),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getLocale: async () => 'en',
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});

import { AccountDeletionBanner } from '@/app/(authed)/_components/AccountDeletionBanner';
import { AccountDeletionBannerBar } from '@/app/(authed)/_components/AccountDeletionBannerBar';
import { AccountDeletionScheduledCard } from '@/app/(authed)/settings/account/_components/AccountDeletionScheduledCard';
import { AppLayout } from '@/components/ui/AppLayout';

/** A request scheduled on the 27th, due on the 26th of the next month. */
function scheduled(): AccountDeletionRequestDTO {
  return {
    id: 'adr_1',
    status: 'scheduled',
    requestedAt: '2026-08-27T00:00:00.000Z',
    erasureDueAt: '2026-09-26T00:00:00.000Z',
    cancelledAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelAccountDeletionAction.mockResolvedValue({ ok: true, request: scheduled() });
});

afterEach(cleanup);

describe('the app-wide banner — mounted in the SHELL, so it is on every authed route', () => {
  it('renders nothing at all when no deletion is scheduled', async () => {
    findOpenDeletion.mockResolvedValue(null);
    expect(await AccountDeletionBanner({ userId: 'u1' })).toBeNull();
    // The overwhelming majority of requests take this arm, so it must cost a
    // read and nothing else — no markup, no client bundle work.
    expect(findOpenDeletion).toHaveBeenCalledWith('u1');
  });

  it('carries the ROW’s date and a Cancel deletion action while one is open', async () => {
    findOpenDeletion.mockResolvedValue(scheduled());
    const html = await renderToHtml(await AccountDeletionBanner({ userId: 'u1' }));
    expect(html).toContain('Sep 26, 2026');
    expect(html).toContain('Cancel deletion');
    // Never a recomputed `now + 30 days`, and no bare `30` in the rendered copy.
    expect(html).not.toMatch(/\b30\b/);
  });

  it('⚠️ is placed ABOVE the top nav, on a route that is NOT the pane', () => {
    // `AppLayout` is the frame EVERY signed-in surface renders inside, so a
    // banner in its slot is on `/home`, `/items`, a board — everywhere. The
    // route below is deliberately not `/settings/account/data`.
    const { container } = render(
      <AppLayout
        banner={<div data-testid="account-deletion-banner">scheduled</div>}
        topNav={<div data-testid="top-nav" />}
        sidebar={<div />}
      >
        <main data-testid="page">/items — a page outside account settings</main>
      </AppLayout>,
    );
    const nodes = Array.from(container.querySelectorAll('*'));
    const banner = screen.getByTestId('account-deletion-banner');
    const topNav = screen.getByTestId('top-nav');
    expect(nodes.indexOf(banner)).toBeLessThan(nodes.indexOf(topNav));
    expect(screen.getByTestId('page').textContent).toContain('outside account settings');
  });

  it('adds NO row to the frame when there is no banner to show', () => {
    const { container: withBanner } = render(
      <AppLayout banner={<div />} topNav={<div />} sidebar={<div />}>
        <div />
      </AppLayout>,
    );
    const before = withBanner.querySelectorAll('.shrink-0').length;
    cleanup();
    const { container: without } = render(
      <AppLayout topNav={<div />} sidebar={<div />}>
        <div />
      </AppLayout>,
    );
    expect(without.querySelectorAll('.shrink-0').length).toBe(before - 1);
  });

  // (That the AUTHED LAYOUT actually fills this slot is asserted where the
  // layout's other structural properties live and its whole mock set already
  // exists — `tests/components/authed-layout-gate.test.tsx`. Asserting it here
  // by reading the file's source would be inspection, not a property.)
});

describe('⚠️ cancelling clears the banner WITHOUT a full reload', () => {
  function renderBar() {
    return render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AccountDeletionBannerBar
          message="Your account is scheduled for deletion on Sep 26, 2026."
          cancelLabel="Cancel deletion"
        />
      </NextIntlClientProvider>,
    );
  }

  it('removes the bar and refreshes the server tree — and never reloads', async () => {
    const original = window.location.reload;
    Object.defineProperty(window.location, 'reload', { configurable: true, value: reload });
    try {
      renderBar();
      expect(screen.getByTestId('account-deletion-banner')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }));

      // Route 3: the mutation fires from INSIDE this island, so the bar goes on
      // the click rather than on the round trip.
      await waitFor(() => expect(screen.queryByTestId('account-deletion-banner')).toBeNull());
      // Route 2: the authoritative half — the server read re-runs, which is
      // what also repaints the pane one route below.
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      // The whole point of the criterion.
      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.location, 'reload', { configurable: true, value: original });
    }
  });

  it('brings the bar BACK when the server refuses, because the row still stands', async () => {
    cancelAccountDeletionAction.mockResolvedValue({ ok: false, code: 'FAILED' });
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' })),
    );
    // The optimistic removal is a LATENCY affordance, not the truth: the
    // deletion is still scheduled, so the door back must still be on screen.
    expect(screen.getByTestId('account-deletion-banner')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the pane’s scheduled state — DECISION 4’s other door', () => {
  it('renders the erasure date from the row and a working Cancel deletion', async () => {
    const html = await renderToHtml(
      await AccountDeletionScheduledCard({
        request: scheduled(),
        locale: 'en',
        now: new Date('2026-09-05T00:00:00.000Z'),
      }),
    );
    expect(html).toContain('Sep 26, 2026');
    expect(html).toContain('Cancel deletion');
    // 21 whole days from the 5th to the 26th — counted from the ROW's own
    // deadline, never from `requestedAt + the constant`.
    expect(html).toContain('21 days left');
    expect(html).not.toMatch(/\b30\b/);
  });

  it('floors the countdown at zero once the erasure has fallen due', async () => {
    const html = await renderToHtml(
      await AccountDeletionScheduledCard({
        request: scheduled(),
        locale: 'en',
        now: new Date('2026-09-27T00:00:00.000Z'),
      }),
    );
    // A due date in the past is a real state — the sweep has not run yet — and
    // "-1 days left" is not something to tell a reader who can still cancel.
    expect(html).toContain('Less than a day left');
  });
});

describe('the pane renders ONE deletion card, never both', () => {
  async function renderPane(): Promise<string> {
    const mod = await import('@/app/(authed)/settings/account/data/page');
    return renderToHtml(await mod.default());
  }

  beforeEach(() => {
    getSession.mockResolvedValue({ user: { id: 'u1', email: 'reader@example.com' } });
    previewAccountErasure.mockResolvedValue({
      blocked: false,
      blockingOrganization: null,
      deleted: {
        credentials: 1,
        passkeys: 0,
        twoFactorEnrolments: 0,
        apiTokens: 0,
        dataExports: 0,
        soleMemberWorkspaces: [],
        projects: 0,
        workItems: 0,
      },
      anonymised: { comments: 0, workItems: 0 },
      kept: ['billing_records', 'backups'],
    });
    getLatestExportForUser.mockResolvedValue(null);
  });

  it('shows the SCHEDULED state and NOT the delete card while a request is open', async () => {
    findOpenDeletion.mockResolvedValue(scheduled());
    const html = await renderPane();

    expect(html).toContain('Your account will be erased on');
    expect(html).toContain('Cancel deletion');
    // With a deletion pending there is nothing left to ask for: the delete
    // card's row copy and its control must both be absent.
    expect(html).not.toContain('Motir will show you exactly what is deleted');
    // And the export stays available, with panel 5's own reason for it.
    expect(html).toContain('there is nothing left to export');
  }, 120_000);

  it('shows the DELETE card and no scheduled state when nothing is open', async () => {
    findOpenDeletion.mockResolvedValue(null);
    const html = await renderPane();

    expect(html).toContain('Motir will show you exactly what is deleted');
    expect(html).not.toContain('Your account will be erased on');
    expect(html).not.toContain('Cancel deletion');
  }, 120_000);
});
