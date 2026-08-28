// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { AccountErasurePreviewDTO } from '@/lib/dto/accountErasure';
import { erasureDueAt } from '@/lib/users/dataSubjectRequests';

// THE CONFIRMATION LEDGER — `design/settings/account-data.mock.html` PANEL 3
// (Story 8.4 · Subtask MOTIR-3704).
//
// Four properties, and three of them are about the dialog's SHAPE rather than
// its content — which is the whole point of the panel:
//
//   1. THE LEDGER. Three groups, each with the reason it belongs there; the
//      sole-membership workspaces NAMED, not merely counted; and the escape
//      stated in the ledger rather than discovered at submit.
//   2. ⚠️ THE CEILING IS NOT RAISED. The design's argument is that the ledger
//      does NOT fit on a 1366×768 laptop and that the cut is a property to
//      keep. That only holds while the shipped `Modal`'s `max-h-[90vh]` stands
//      and `Modal.Body` scrolls, so this suite asserts the ABSENCE of a height
//      override — the one thing a future author would "fix" without noticing
//      what it was for.
//   3. THE FIELD IS BELOW THE LEDGER, IN DOM ORDER. That is what makes the
//      confirm unreachable without travelling past the facts. A visual
//      assertion could not see it; `compareDocumentPosition` can.
//   4. THE CONFIRM IS DISABLED UNTIL THE TYPED VALUE MATCHES.

const scheduleAccountDeletionAction = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/app/(authed)/_account-deletion-actions', () => ({ scheduleAccountDeletionAction }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/ui/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/Toast')>()),
  useToast: () => ({ toast }),
}));

import { DeleteAccountConfirmModal } from '@/app/(authed)/settings/account/_components/DeleteAccountConfirmModal';

const EMAIL = 'reader@example.com';

/** A reader with something in every group — the ledger's fully-populated case. */
function preview(): AccountErasurePreviewDTO {
  return {
    blocked: false,
    blockingOrganization: null,
    deleted: {
      credentials: 1,
      passkeys: 2,
      twoFactorEnrolments: 1,
      apiTokens: 3,
      soleMemberWorkspaces: [
        { id: 'ws_1', name: 'Personal' },
        { id: 'ws_2', name: 'moooon labs' },
      ],
      projects: 12,
      workItems: 1483,
    },
    anonymised: { comments: 214, workItems: 96 },
    kept: ['billing_records', 'backups'],
  };
}

function renderModal(overrides: Partial<AccountErasurePreviewDTO> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <DeleteAccountConfirmModal
        open
        onOpenChange={() => {}}
        preview={{ ...preview(), ...overrides }}
        email={EMAIL}
        projectedErasureDueAt={erasureDueAt(new Date('2026-08-27T00:00:00.000Z')).toISOString()}
      />
    </NextIntlClientProvider>,
  );
}

/** The rendered dialog panel — Radix portals it, so reach for it by role. */
function dialog(): HTMLElement {
  return screen.getByRole('alertdialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  scheduleAccountDeletionAction.mockResolvedValue({
    ok: true,
    request: {
      id: 'adr_1',
      status: 'scheduled',
      requestedAt: '2026-08-27T00:00:00.000Z',
      erasureDueAt: '2026-09-26T00:00:00.000Z',
      cancelledAt: null,
    },
  });
});

afterEach(cleanup);

describe('the ledger — three groups, each with the reason it belongs there', () => {
  it('renders all three group headings and their reasons', () => {
    renderModal();
    const panel = dialog();
    for (const [heading, why] of [
      ['Deleted', 'Yours alone'],
      ['Anonymised, not deleted', "Part of someone else's project"],
      ['Kept', 'Required by law'],
    ] as const) {
      expect(within(panel).getByRole('heading', { name: new RegExp(heading) })).toBeTruthy();
      expect(panel.textContent).toContain(why);
    }
  });

  it('NAMES each sole-membership workspace, and states the invite-somebody escape', () => {
    const panel = (renderModal(), dialog());
    // Named, not merely counted — the DTO carries names for exactly this, and a
    // reader deciding whether to lose a workspace has to know WHICH.
    expect(panel.textContent).toContain('Personal');
    expect(panel.textContent).toContain('moooon labs');
    expect(panel.textContent).toContain('To keep one, invite somebody to it first.');
  });

  it('renders the counts the impact preview measured, and the KEPT rows it did not', () => {
    const panel = (renderModal(), dialog());
    expect(panel.textContent).toContain('214'); // anonymised comments
    expect(panel.textContent).toContain('96'); // anonymised work items
    expect(panel.textContent).toContain('1,483'); // work inside the sole workspaces
    // `kept` is a closed set of KEYS, never a count — the Privacy Policy §6
    // states these as exceptions, so the ledger names them.
    expect(panel.textContent).toContain('Invoices and tax records');
    expect(panel.textContent).toContain('Backups, until they rotate');
  });

  it('omits the workspace rows entirely when the reader is nobody’s only member', () => {
    const panel =
      (renderModal({
        deleted: { ...preview().deleted, soleMemberWorkspaces: [], projects: 0, workItems: 0 },
      }),
      dialog());
    expect(panel.textContent).not.toContain('Workspaces where you are the only member');
    // The identity row is unconditional — it is what deletion always reaches.
    expect(panel.textContent).toContain('Your profile and how you sign in');
  });

  it('interpolates the erasure date from the projected due date, and types no `30`', () => {
    const panel = (renderModal(), dialog());
    // `erasureDueAt('2026-08-27') === '2026-09-26'` — the named helper over the
    // ONE published constant, computed on the server and handed in.
    expect(panel.textContent).toContain('Sep 26, 2026');
    expect(panel.textContent).toContain('Nothing is erased today.');
  });
});

describe('⚠️ the dialog is drawn at its REAL ceiling — the cut is the point', () => {
  it('uses the shipped `lg` panel and RAISES NO HEIGHT CAP', () => {
    renderModal();
    const panel = dialog();
    // 32 rem: the ledger needs the width, and the next size up is the 58 rem
    // peek surface, which is not a confirmation dialog.
    expect(panel.className).toContain('max-w-[32rem]');
    // The shipped cap, untouched.
    expect(panel.className).toContain('max-h-[90vh]');
    // ⚠️ THE ASSERTION THIS SUITE EXISTS FOR. Any second `max-h-*` would be an
    // override of the cap the whole design rests on — including the
    // "helpful" `max-h-none` / `max-h-screen` a future reader reaches for when
    // the ledger looks cut off. It is SUPPOSED to look cut off.
    expect(panel.className.split(/\s+/).filter((c) => c.startsWith('max-h-'))).toEqual([
      'max-h-[90vh]',
    ]);
  });

  it('scrolls its BODY, with the head and footer pinned by the flex column', () => {
    renderModal();
    const body = dialog().querySelector('[data-slot="modal-body"], .overflow-y-auto');
    expect(body).not.toBeNull();
    expect(body!.className).toContain('overflow-y-auto');
    // `min-h-0` is what lets the flex child actually shrink and scroll instead
    // of growing the panel past its cap — without it the cap is inert.
    expect(body!.className).toContain('min-h-0');
    expect(body!.className).toContain('flex-1');
  });

  it('puts the type-to-confirm field BELOW the ledger in DOM order', () => {
    renderModal();
    const panel = dialog();
    const keptHeading = within(panel).getByRole('heading', { name: /Kept/ });
    const field = within(panel).getByLabelText(/Type .* to confirm/);
    // Document order over the panel's own descendants: the field comes AFTER
    // the last ledger group, so the confirm cannot be reached without
    // travelling past every fact. (`compareDocumentPosition` answers 0 under
    // happy-dom, so the index is the assertion that actually measures order.)
    const inOrder = Array.from(panel.querySelectorAll('*'));
    expect(inOrder.indexOf(field)).toBeGreaterThan(inOrder.indexOf(keptHeading));
    expect(inOrder.indexOf(keptHeading)).toBeGreaterThan(-1);
  });
});

describe('the type-to-confirm gate', () => {
  it('keeps the confirm DISABLED until the typed value matches exactly', () => {
    renderModal();
    const confirm = within(dialog()).getByRole('button', { name: 'Delete my account' });
    expect(confirm).toHaveProperty('disabled', true);

    const field = within(dialog()).getByLabelText(/Type .* to confirm/);
    fireEvent.change(field, { target: { value: 'reader@example.co' } }); // one short
    expect(confirm).toHaveProperty('disabled', true);

    fireEvent.change(field, { target: { value: EMAIL } });
    expect(confirm).toHaveProperty('disabled', false);
  });

  it('does not schedule anything while the value does not match', () => {
    renderModal();
    const field = within(dialog()).getByLabelText(/Type .* to confirm/);
    fireEvent.change(field, { target: { value: 'not-my-email' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete my account' }));
    expect(scheduleAccountDeletionAction).not.toHaveBeenCalled();
  });

  it('calls the schedule action on a match, and refreshes the server surfaces', async () => {
    renderModal();
    const field = within(dialog()).getByLabelText(/Type .* to confirm/);
    fireEvent.change(field, { target: { value: EMAIL } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete my account' }));

    await waitFor(() => expect(scheduleAccountDeletionAction).toHaveBeenCalledTimes(1));
    // The pane and the app-wide banner are BOTH server-rendered, so one refresh
    // repaints both (CLAUDE.md's page-state contract, route 2).
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('reports the residual BLOCKED refusal in its own words, and does not refresh', async () => {
    scheduleAccountDeletionAction.mockResolvedValue({ ok: false, code: 'BLOCKED' });
    renderModal();
    const field = within(dialog()).getByLabelText(/Type .* to confirm/);
    fireEvent.change(field, { target: { value: EMAIL } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete my account' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'error',
          title: en.settings.account.data.delete.confirm.blockedError,
        }),
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('⚠️ the window is INTERPOLATED — no component and no string retypes `30`', () => {
  // `content/legal/privacy.md` §6 promises erasure *"within 30 days"*, and
  // `ACCOUNT_ERASURE_WINDOW_DAYS` is the one place that number lives so the
  // promise and the behaviour cannot drift. The service source already carries
  // this assertion (`tests/account-deletion-schedule.test.ts`); this is the
  // same guard over the SURFACES this card adds, which are where a hand-typed
  // "30 days" is most tempting and least visible.
  const SOURCES = [
    'app/(authed)/_account-deletion-actions.ts',
    'app/(authed)/_components/AccountDeletionBanner.tsx',
    'app/(authed)/_components/AccountDeletionBannerBar.tsx',
    'app/(authed)/settings/account/_components/AccountDeletionScheduledCard.tsx',
    'app/(authed)/settings/account/_components/CancelAccountDeletionButton.tsx',
    'app/(authed)/settings/account/_components/DeleteAccountConfirmModal.tsx',
    'app/(authed)/settings/account/_components/DeleteAccountTrigger.tsx',
  ];

  it.each(SOURCES)('%s carries no bare `30` outside a comment', (file) => {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      // Prose ABOUT the window is the point of these files' comments; a literal
      // in executable code is the defect.
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\b30\b/);
  });

  it('the added COPY interpolates the date and the countdown, and states no number', () => {
    const copy = JSON.stringify([
      en.settings.account.data.delete.confirm,
      en.settings.account.data.delete.grace,
      en.settings.account.data.banner,
    ]);
    expect(copy).not.toMatch(/\b30\b/);
    // Every place the window shows up is a placeholder the row fills.
    expect(en.settings.account.data.banner.scheduled).toContain('{date}');
    expect(en.settings.account.data.delete.grace.title).toContain('{date}');
    expect(en.settings.account.data.delete.grace.daysLeft).toContain('{days');
    expect(en.settings.account.data.delete.confirm.schedule).toContain('{date}');
  });
});
