// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PublicSubmitRequestForm } from '@/app/(public)/_components/PublicSubmitRequestForm';

// Component test for the signed-in public submit form + duplicate detection
// (Story 6.12 · Subtask 6.12.11). Drives the real form against a mocked fetch —
// the dedupe pre-check (GET …/duplicates), the create (POST …/requests, incl.
// the 429 rate-limit), and the "upvote this instead" target (POST
// /api/public-requests/[id]/upvote) — asserting the user-visible state machine.

interface Handlers {
  duplicates?: () => { status?: number; body: unknown };
  submit?: () => { status?: number; body: unknown };
  upvote?: () => { status?: number; body: unknown };
}

function installFetch(handlers: Handlers) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    let res: { status?: number; body: unknown } | undefined;
    if (url.includes('/requests/duplicates'))
      res = handlers.duplicates?.() ?? { body: { candidates: [] } };
    else if (url.includes('/upvote') && method === 'POST') res = handlers.upvote?.();
    else if (url.includes('/requests') && method === 'POST') res = handlers.submit?.();
    const status = res?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => res?.body ?? {},
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderForm(overrides: Partial<Parameters<typeof PublicSubmitRequestForm>[0]> = {}) {
  const onClose = vi.fn();
  renderWithIntl(
    <PublicSubmitRequestForm
      projectId="proj-1"
      roadmapHref="/p/PROD/roadmap"
      submitterName="Ada"
      submitterOrg="Acme"
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose };
}

const MATCH = {
  id: 'wi-9',
  kind: 'task' as const,
  identifier: 'PROD-9',
  title: 'Dark mode for the whole app',
  status: 'planned',
  voteCount: 88,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PublicSubmitRequestForm', () => {
  beforeEach(() => {
    installFetch({});
  });

  it('renders the attribution hint and disables submit until a title is entered', () => {
    renderForm();
    expect(
      screen.getByText('Submitted as Ada (Acme) — your account is attached for follow-up.'),
    ).toBeTruthy();
    const submit = screen.getByRole('button', { name: /Submit request/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Dark mode' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('degrades the attribution hint to name-only when the org is unknown', () => {
    renderForm({ submitterOrg: null });
    expect(
      screen.getByText('Submitted as Ada — your account is attached for follow-up.'),
    ).toBeTruthy();
  });

  it('surfaces duplicate matches as the title is typed and upvotes the existing one (no new item)', async () => {
    const fetchFn = installFetch({
      duplicates: () => ({ body: { candidates: [MATCH] } }),
      upvote: () => ({ body: { voted: true, voteCount: 89 } }),
    });
    renderForm();

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Dark mode' },
    });

    // The dedupe candidate surfaces (debounced fetch).
    expect(await screen.findByText('Dark mode for the whole app')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Upvote this/ }));

    // Lands on the "your vote is in" confirmation — and NO create POST fired.
    expect(await screen.findByText('Thanks — your vote is in')).toBeTruthy();
    const postedRequests = fetchFn.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/requests') && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postedRequests).toHaveLength(0);
  });

  it('submits a new request after dismissing the dedupe and shows the confirmation', async () => {
    installFetch({
      duplicates: () => ({ body: { candidates: [MATCH] } }),
      submit: () => ({
        status: 201,
        body: { id: 'new-1', kind: 'task', identifier: 'PROD-42', title: 'X' },
      }),
    });
    renderForm();

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Dark mode' },
    });
    // Dismiss the dedupe ("submit as new"), then submit.
    fireEvent.click(await screen.findByText(/Continue and submit as new/));
    fireEvent.click(screen.getByRole('button', { name: /Submit request/ }));

    expect(await screen.findByText('Thanks — we got it')).toBeTruthy();
  });

  it('shows the rate-limited banner when the submit is throttled (429)', async () => {
    installFetch({
      submit: () => ({ status: 429, body: { code: 'PUBLIC_SUBMISSION_RATE_LIMITED' } }),
    });
    renderForm({ submitterOrg: null });

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Spam spam spam' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit request/ }));

    expect(await screen.findByText('You’re submitting a little too fast')).toBeTruthy();
    // Still on the form (not the confirmation) so the draft is preserved.
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'Spam spam spam',
    );
  });
});
