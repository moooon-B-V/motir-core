// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { BillingStatusDTO, EnterpriseRequestDTO } from '@/lib/dto/billing';
import { useTranslations } from 'next-intl';
import {
  BillingClient,
  EnterpriseContactControl,
} from '@/app/(authed)/settings/organization/billing/_components/BillingClient';

// The Enterprise card's Contact sales (Story MOTIR-7602 · Subtask MOTIR-7607;
// design `billing--contact-sales.mock.html` panels 2–8). Drives the real
// BillingClient island against a stubbed boundary — the billing GET, and the
// enterprise-request GET / POST (MOTIR-7605's routes, whose own behaviour is
// pinned against real Postgres in `tests/api-billing-enterprise-request-route`
// and `tests/billing/enterprise-request-service`). One case per drawn state:
// the manager's control and the form it opens, the member's disabled control,
// validation, sending, sent → "Request sent" re-read from a fresh GET, the 409
// a parallel tab causes, the 403, and the network error that keeps the form.

const ENTERPRISE_URL = '/api/organizations/org1/billing/enterprise-request';

function billing(canManage = true): BillingStatusDTO {
  return {
    organizationId: 'org1',
    access: canManage
      ? { role: 'owner', canManageBilling: true }
      : { role: 'admin', canManageBilling: false },
    isMeta: false,
    internalBilling: false,
    search: { totalSpend: 0, monthSpend: 0 },
    agents: { spend: { machineMonthSpend: 0, storageMonthSpend: 0 }, hasPaidAiPlan: true },
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
    ci: {
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
    },
    catalog: BILLING_CATALOG,
  };
}

function openRequest(over: Partial<EnterpriseRequestDTO> = {}): EnterpriseRequestDTO {
  return {
    id: 'req1',
    status: 'received',
    createdAt: '2026-10-05T10:00:00.000Z',
    cardsPerDay: 40,
    parallelAgents: 8,
    agentPath: 'own',
    autonomy: 'autonomous_lead',
    startWhen: 'within_month',
    teamSize: null,
    contact: 'sam@moooon.example',
    note: 'We want Motir to run our three product repositories overnight.',
    requestedByName: 'Sam Rivera',
    ...over,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * A boundary stub. `gets` are the enterprise-request GET answers in order (the
 * last one repeats); `post` answers the send.
 */
function stubBoundary(opts: {
  canManage?: boolean;
  gets?: Array<EnterpriseRequestDTO | null | 'forbidden'>;
  post?: () => Promise<Response>;
}) {
  const gets = [...(opts.gets ?? [null])];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/organizations/org1/billing') return json(billing(opts.canManage ?? true));
    if (url === ENTERPRISE_URL && (init?.method ?? 'GET') === 'GET') {
      const next = gets.length > 1 ? gets.shift()! : gets[0]!;
      return next === 'forbidden' ? json({ code: 'BILLING_FORBIDDEN' }, 403) : json(next);
    }
    if (url === ENTERPRISE_URL && init?.method === 'POST') {
      if (!opts.post) throw new Error('unexpected POST');
      return opts.post();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const calls = (method: 'GET' | 'POST') =>
    fetchMock.mock.calls.filter(
      ([u, init]) => u === ENTERPRISE_URL && ((init as RequestInit)?.method ?? 'GET') === method,
    );
  return { fetchMock, calls };
}

function renderClient(withContext = true) {
  return render(
    <ToastProvider>
      <BillingClient
        orgId="org1"
        orgName="Acme"
        memberCount={6}
        contactSales={
          withContext
            ? {
                requesterName: 'Sam Rivera',
                requesterEmail: 'sam@moooon.example',
                repositoryCount: 4,
              }
            : null
        }
      />
    </ToastProvider>,
  );
}

/** Land on the AI plans screen, where the Enterprise card lives. */
async function goToPlans() {
  await waitFor(() => expect(screen.getByText('Billing & plans')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
  await waitFor(() => expect(screen.getByText('Motir AI — plans & subscription')).toBeTruthy());
}

async function openForm() {
  await goToPlans();
  fireEvent.click(screen.getByRole('button', { name: 'Contact sales' }));
  return screen.getByRole('dialog', { name: 'Contact sales — Enterprise' });
}

function ControlHarness(props: { canManage: boolean; request: EnterpriseRequestDTO | null }) {
  const t = useTranslations('billing');
  return (
    <EnterpriseContactControl
      enterprise={{
        orgId: 'org1',
        context: null,
        request: props.request,
        refresh: async () => null,
      }}
      canManage={props.canManage}
      orgName="Acme"
      planName="Standard"
      t={t}
    />
  );
}

function renderControl(props: { canManage: boolean; request: EnterpriseRequestDTO | null }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('the control alone fetches nothing');
    }),
  );
  return render(<ControlHarness {...props} />);
}

function noteField(dialog: HTMLElement) {
  return within(dialog).getByRole('textbox', { name: /^Note/ }) as HTMLTextAreaElement;
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/settings/organization/billing', search: '' },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Enterprise card — Contact sales (MOTIR-7607)', () => {
  it('is a button that opens the request form for a manager — no mailto: anywhere', async () => {
    stubBoundary({});
    renderClient();
    await goToPlans();

    const control = screen.getByRole('button', { name: 'Contact sales' });
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect((control as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();

    fireEvent.click(control);
    expect(screen.getByRole('dialog', { name: 'Contact sales — Enterprise' })).toBeTruthy();
  });

  // ⚠️ A member never reaches the plans screen in the shipped flow (its doors —
  // ② Change plan, the CI paused decision — are manager-only), so the member
  // variants are pinned on the control itself rather than through the page.
  it('is disabled for a member, with the reason said under it and wired as its description', () => {
    renderControl({ canManage: false, request: null });

    const control = screen.getByRole('button', { name: 'Contact sales' }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    const reasonId = control.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      'Only owners and admins of Acme can contact sales.',
    );
  });

  it('asks only what the person alone knows; the org, requester, plan and repositories are read-only', async () => {
    stubBoundary({});
    renderClient();
    const dialog = await openForm();

    // Read-only — text in the summary box, never an input.
    const facts = within(dialog).getByRole('region', { name: 'Sent with your request' });
    for (const [k, v] of [
      ['Organization', 'Acme'],
      ['Requested by', 'Sam Rivera'],
      ['Current plan', 'Standard'],
      ['Repositories connected', '4'],
    ] as const) {
      expect(within(facts).getByText(k)).toBeTruthy();
      expect(within(facts).getByText(v)).toBeTruthy();
    }
    expect(facts.querySelectorAll('input, textarea, select, [role="combobox"]')).toHaveLength(0);

    // The inputs, exactly: two counts, two radio groups of three, two pick-lists,
    // the contact (prefilled with the account email) and the note.
    expect(within(dialog).getAllByRole('spinbutton')).toHaveLength(2);
    expect(
      within(dialog).getByRole('spinbutton', { name: 'Work items a day, roughly' }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('spinbutton', { name: 'Agents in parallel' })).toBeTruthy();
    expect(within(dialog).getAllByRole('radiogroup')).toHaveLength(2);
    expect(within(dialog).getAllByRole('radio')).toHaveLength(6);
    expect(within(dialog).getByRole('radiogroup', { name: 'Which agents' })).toBeTruthy();
    expect(within(dialog).getByRole('radiogroup', { name: 'How should it run?' })).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('combobox')
        .map((el) => el.getAttribute('aria-label')),
    ).toEqual(['When would you start?', 'Team size']);
    const textboxes = within(dialog).getAllByRole('textbox');
    expect(textboxes).toHaveLength(2);
    expect(
      (within(dialog).getByRole('textbox', { name: 'Best way to reach you' }) as HTMLInputElement)
        .value,
    ).toBe('sam@moooon.example');
    expect(noteField(dialog).required).toBe(true);
  });

  it('validates before sending: the note is required, a count must be a whole number ≥ 1', async () => {
    const { calls } = stubBoundary({ post: async () => json(openRequest(), 201) });
    renderClient();
    const dialog = await openForm();

    const cards = within(dialog).getByRole('spinbutton', { name: 'Work items a day, roughly' });
    fireEvent.change(cards, { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

    expect(within(dialog).getByText('Enter a whole number of at least 1.')).toBeTruthy();
    expect(
      within(dialog).getByText('Add a note — tell us what you want Motir to do for your team.'),
    ).toBeTruthy();
    expect(cards.getAttribute('aria-invalid')).toBe('true');
    expect(noteField(dialog).getAttribute('aria-invalid')).toBe('true');
    // Focus moves to the first invalid field, and nothing was sent.
    expect(document.activeElement).toBe(cards);
    expect(calls('POST')).toHaveLength(0);
  });

  it('sends once, locks the form while sending, then confirms — and the card reads Request sent from a fresh GET', async () => {
    let answer!: (r: Response) => void;
    const { calls } = stubBoundary({
      // The load sees nothing open; the re-read after the send sees the request.
      gets: [null, openRequest()],
      post: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    renderClient();
    const dialog = await openForm();

    fireEvent.click(within(dialog).getByRole('radio', { name: /Our own agents/ }));
    fireEvent.change(noteField(dialog), { target: { value: '  Run our backlog overnight.  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

    // Sending (panel 5): the primary action busy, every input and Cancel locked,
    // the corner × gone so the dialog cannot be dismissed mid-request.
    const sending = within(dialog).getByRole('button', { name: /Sending…/ });
    expect(sending.getAttribute('aria-busy')).toBe('true');
    expect(noteField(dialog).disabled).toBe(true);
    expect(
      (within(dialog).getByRole('spinbutton', { name: 'Agents in parallel' }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();

    const getsBefore = calls('GET').length;
    await act(async () => answer(json(openRequest({ contact: 'ops@moooon.example' }), 201)));

    // Exactly one POST, carrying the trimmed answers and nulls for the unset ones.
    expect(calls('POST')).toHaveLength(1);
    expect(JSON.parse((calls('POST')[0]![1] as RequestInit).body as string)).toEqual({
      cardsPerDay: null,
      parallelAgents: null,
      agentPath: 'own',
      autonomy: null,
      startWhen: null,
      teamSize: null,
      contact: 'sam@moooon.example',
      note: 'Run our backlog overnight.',
    });
    // The card re-read the open request from the server after the send.
    expect(calls('GET').length).toBe(getsBefore + 1);

    // Sent (panel 6).
    const sent = await screen.findByRole('dialog', { name: 'Request sent' });
    expect(within(sent).getByText('ops@moooon.example')).toBeTruthy();
    fireEvent.click(within(sent).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The card, in place of Contact sales.
    expect(screen.queryByRole('button', { name: 'Contact sales' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Request sent · Oct 5, 2026$/ })).toBeTruthy();
  });

  it('a 409 from a parallel tab shows the open request, not an error', async () => {
    stubBoundary({
      gets: [null, openRequest()],
      post: async () =>
        json(
          {
            code: 'ENTERPRISE_REQUEST_OPEN',
            error: 'This organization already has an open Enterprise request.',
            openRequestId: 'req1',
          },
          409,
        ),
    });
    renderClient();
    const dialog = await openForm();
    fireEvent.change(noteField(dialog), { target: { value: 'Again.' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    });

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Your organization already has an open request.');
    expect(alert.textContent).toContain('It was sent on Oct 5, 2026');
    expect(
      (within(dialog).getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // The card behind it (aria-hidden under the modal) already swapped to
    // Request sent, from the re-read.
    expect(
      screen.getByRole('button', { name: /^Request sent · Oct 5, 2026$/, hidden: true }),
    ).toBeTruthy();

    fireEvent.click(within(alert).getByRole('button', { name: 'View the request' }));
    const view = screen.getByRole('dialog', { name: 'Your Enterprise request' });
    expect(within(view).getByText('Sent Oct 5, 2026 by Sam Rivera.')).toBeTruthy();
    expect(within(view).getByText('Received')).toBeTruthy();
    expect(within(view).queryByRole('textbox')).toBeNull();
    expect(within(view).queryByRole('button', { name: 'Send request' })).toBeNull();
  });

  it('a network error keeps every typed value and leaves Send enabled to retry', async () => {
    const { calls } = stubBoundary({
      post: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    renderClient();
    const dialog = await openForm();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Agents in parallel' }), {
      target: { value: '8' },
    });
    fireEvent.change(noteField(dialog), { target: { value: 'Keep me.' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    });

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t reach Motir.');
    expect(noteField(dialog).value).toBe('Keep me.');
    expect(
      (within(dialog).getByRole('spinbutton', { name: 'Agents in parallel' }) as HTMLInputElement)
        .value,
    ).toBe('8');
    expect(
      (within(dialog).getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(calls('POST')).toHaveLength(1);
    // Nothing was sent, so the card still offers Contact sales.
    expect(screen.getByRole('button', { name: 'Contact sales', hidden: true })).toBeTruthy();
  });

  it('a 403 (the role changed since the page loaded) keeps the form and disables Send', async () => {
    stubBoundary({
      post: async () => json({ code: 'BILLING_FORBIDDEN', error: 'nope' }, 403),
    });
    renderClient();
    const dialog = await openForm();
    fireEvent.change(noteField(dialog), { target: { value: 'Hello.' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    });

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('You can’t contact sales for Acme.');
    expect(
      (within(dialog).getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('with an open request on load, the card says Request sent and opens it read-only', async () => {
    stubBoundary({ gets: [openRequest({ status: 'in_conversation', note: 'Line one.' })] });
    renderClient();
    await goToPlans();

    const control = screen.getByRole('button', { name: /^Request sent · Oct 5, 2026$/ });
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(screen.queryByRole('button', { name: 'Contact sales' })).toBeNull();

    fireEvent.click(control);
    const view = screen.getByRole('dialog', { name: 'Your Enterprise request' });
    expect(within(view).getByText('In conversation')).toBeTruthy();
    expect(within(view).getByText('Line one.')).toBeTruthy();
    // An unset answer says so.
    expect(within(view).getByText('Not given')).toBeTruthy();
    expect(within(view).getByText('Our own agents')).toBeTruthy();
    fireEvent.click(within(view).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a member who can see an open request gets the line, not a door', () => {
    renderControl({ canManage: false, request: openRequest() });

    expect(screen.getByText('Request sent · Oct 5, 2026')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
