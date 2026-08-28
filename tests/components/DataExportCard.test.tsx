// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { DataExportRequestDTO } from '@/lib/dto/dataExport';

// The export card on Account › Data & privacy (Story 8.4 · Subtask MOTIR-1136),
// built to `design/settings/account-data.mock.html` panels 1 and 2.
//
// ⚠️ WHAT THIS SUITE IS FOR: the card's per-status ROUTING, over the WHOLE live
// enum. The card's own prose enumerates "idle · preparing · ready · failed" and
// the shipped `DataExportStatus` carries a fourth value it leaves out —
// `expired` — so a renderer written to the card alone is a partial function over
// a column the database can really hold. The `every value` case below is the
// assertion that catches that, and it reads the enum out of the SCHEMA rather
// than restating the four names here, so a fifth value added later fails this
// test instead of rendering an empty card in production.
//
// The Server Action is mocked: its own session gate, rate limit and service call
// are covered against real Postgres by `tests/export/dataExportLatest.test.ts`
// and `tests/export/dataExportService.test.ts`. What this file owns is what the
// reader SEES for each answer.

const { requestDataExportAction } = vi.hoisted(() => ({
  requestDataExportAction: vi.fn(),
}));

vi.mock('@/app/(authed)/settings/account/data/actions', () => ({
  requestDataExportAction,
}));

const { DataExportCard } =
  await import('@/app/(authed)/settings/account/_components/DataExportCard');

const EMAIL = 'reader@example.com';

/** A request row in one status, with the timestamps that status really carries. */
function requestIn(status: DataExportRequestDTO['status']): DataExportRequestDTO {
  const requestedAt = '2026-08-20T09:00:00.000Z';
  const builtAt = '2026-08-20T09:12:00.000Z';
  return {
    id: 'exp_1',
    status,
    requestedAt,
    builtAt: status === 'preparing' || status === 'failed' ? null : builtAt,
    expiresAt: status === 'ready' ? '2026-08-27T09:12:00.000Z' : null,
  };
}

function renderCard(request: DataExportRequestDTO | null) {
  return render(
    <ToastProvider>
      <DataExportCard request={request} email={EMAIL} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  requestDataExportAction.mockResolvedValue({ ok: true, started: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DataExportCard — the IDLE state (no request row)', () => {
  it('explains what the export IS, and offers the control that asks for one', () => {
    renderCard(null);

    expect(screen.getByRole('heading', { name: 'Export your data' })).toBeTruthy();
    // The three things a reader receives, drawn as rows (panel 1).
    expect(screen.getByText('Your profile and account')).toBeTruthy();
    expect(screen.getByText('Your workspaces and projects')).toBeTruthy();
    expect(screen.getByText('Your files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request export' })).toBeTruthy();
  });

  it('states the format and the one-month promise, not a promise of minutes', () => {
    renderCard(null);
    // Art. 12(3) allows one month; the mechanism usually takes minutes. The copy
    // states the LEGAL promise, because a surface that promises instant owes it.
    expect(screen.getByText(/one month/)).toBeTruthy();
    expect(screen.getByText(/JSON \+ your files, in one \.zip/)).toBeTruthy();
  });

  it('has no status chip at all — idle is the ABSENCE of a row, not a status', () => {
    renderCard(null);
    for (const label of ['In progress', 'Ready', 'Failed', 'Expired']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});

describe('DataExportCard — one rendered state per value of the live status enum', () => {
  it.each([
    ['preparing', 'In progress'],
    ['ready', 'Ready'],
    ['failed', 'Failed'],
    ['expired', 'Expired'],
  ] as const)('%s renders its own chip and body', (status, chip) => {
    renderCard(requestIn(status));
    expect(screen.getByText(chip)).toBeTruthy();
    // Once a request exists the card is about THAT file, so the standing
    // explanation gives way to the file row (panel 2).
    expect(screen.queryByText('Your profile and account')).toBeNull();
    expect(screen.getByText('motir-export.zip')).toBeTruthy();
  });

  it('⚠️ covers EVERY value the schema enum can hold — read from the schema, not restated', async () => {
    const { readFileSync } = await import('node:fs');
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const block = /enum DataExportStatus \{([\s\S]*?)\n\}/.exec(schema);
    if (block === null) throw new Error('DataExportStatus not found in prisma/schema.prisma');
    const values = block[1]!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('/') && !line.startsWith('@'));

    // The whole point of this assertion: it FAILS when somebody adds a value to
    // the enum without giving the pane a state for it, rather than the pane
    // rendering nothing for a row the database really holds.
    expect(values.sort()).toEqual(['expired', 'failed', 'preparing', 'ready']);

    for (const value of values) {
      cleanup();
      renderCard(requestIn(value as DataExportRequestDTO['status']));
      expect(screen.getByText('motir-export.zip'), `no body rendered for ${value}`).toBeTruthy();
    }
  });
});

describe('DataExportCard — preparing', () => {
  it('names the address the notification goes to, and disables a second request', () => {
    renderCard(requestIn('preparing'));
    expect(screen.getByText(new RegExp(EMAIL))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request export' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('DataExportCard — ready', () => {
  it('hands the file over IN THE PANE, through the authenticated download route', () => {
    renderCard(requestIn('ready'));
    const link = screen.getByRole('link', { name: 'Download' });
    // Never a stored URL: the route mints a fresh 300 s presigned link per click,
    // which is what makes the copy beside it true rather than decorative.
    expect(link.getAttribute('href')).toBe('/api/account/data-export/exp_1/download');
    expect(screen.getByText(/expires after five minutes/)).toBeTruthy();
    expect(screen.getByText(/kept for 7 days/)).toBeTruthy();
  });

  it('states the deadline as a DATE, from the row rather than from a countdown', () => {
    renderCard(requestIn('ready'));
    expect(screen.getByText(/Available until Aug 27, 2026/)).toBeTruthy();
  });
});

describe('DataExportCard — failed', () => {
  it('routes to the published mailbox and offers a retry', () => {
    renderCard(requestIn('failed'));
    // DECISION 2's Art. 12(3) path: the case the automated build cannot serve.
    expect(screen.getByText(/privacy@motir\.co/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says nothing was sent and nothing changed — a failed build is not a mutation', () => {
    renderCard(requestIn('failed'));
    expect(screen.getByText(/nothing in your account changed/)).toBeTruthy();
  });
});

describe('DataExportCard — expired', () => {
  it('says what happened rather than showing nothing, and offers a fresh copy', () => {
    renderCard(requestIn('expired'));
    expect(screen.getByText('This export is no longer available.')).toBeTruthy();
    expect(screen.getByText(/kept for 7 days, and this one has passed that/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request export' })).toBeTruthy();
  });
});

describe('DataExportCard — asking for an export', () => {
  it('calls the action and advances to the preparing state', async () => {
    renderCard(null);
    fireEvent.click(screen.getByRole('button', { name: 'Request export' }));

    await waitFor(() => expect(requestDataExportAction).toHaveBeenCalledTimes(1));
    // The island holds what it just learned: `revalidatePath` re-runs the pane's
    // server read, and a refresh cannot reach a `useState` initializer.
    await screen.findByText('In progress');
  });

  it('an already-open request is a SUCCESS, not a refusal', async () => {
    requestDataExportAction.mockResolvedValue({ ok: true, started: false });
    renderCard(null);
    fireEvent.click(screen.getByRole('button', { name: 'Request export' }));

    // The reader asked for an export and there is one being built — the same
    // honest answer either way.
    await screen.findByText('In progress');
  });

  it('surfaces a refusal as a toast and stays idle', async () => {
    requestDataExportAction.mockResolvedValue({ ok: false, code: 'RATE_LIMITED' });
    renderCard(null);
    fireEvent.click(screen.getByRole('button', { name: 'Request export' }));

    await screen.findByText("We couldn't start your export. Try again in a moment.");
    expect(screen.queryByText('In progress')).toBeNull();
    expect(screen.getByText('Your profile and account')).toBeTruthy();
  });

  it('retries from the FAILED state through the same action', async () => {
    renderCard(requestIn('failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(requestDataExportAction).toHaveBeenCalledTimes(1));
    await screen.findByText('In progress');
  });
});
