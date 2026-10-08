// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { EnterpriseRequestDTO } from '@/lib/dto/billing';
import type {
  EnterpriseRequestStatusValue,
  PlatformEnterpriseRequestDTO,
  PlatformEnterpriseRequestPageDTO,
} from '@/lib/dto/platformEnterpriseRequest';

/**
 * STORY MOTIR-7602's INTEGRATION GATE (MOTIR-7610) — the browser half.
 *
 * The edges the per-card suites left unrendered, each a state a person can
 * reach: the Contact-sales dialog opened directly (no page context, a server
 * 400 on each field, a 409 whose winner could not be re-read, a double press, a
 * dismiss mid-send), the browser client's every folded answer, and the
 * console's detail, list row and state card with the answers an org may leave
 * blank. The server half — seams, race and guards on the real Postgres — is
 * `tests/billing/enterpriseRequestStoryGate.test.ts`.
 *
 * The one boundary stubbed is `fetch` (the dialog and client) and the console's
 * server action (the state card); everything rendered is the shipped component
 * with the real `en` catalogue.
 */

const transitionEnterpriseRequestAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock('@/app/(admin)/admin/enterprise-requests/actions', () => ({
  transitionEnterpriseRequestAction,
}));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const { ContactSalesDialog } =
  await import('@/app/(authed)/settings/organization/billing/_components/ContactSalesDialog');
const { fetchOpenEnterpriseRequest, sendEnterpriseRequest } =
  await import('@/lib/billing/enterpriseRequestClient');
const { EnterpriseRequestsCard } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestsCard');
const { EnterpriseRequestDetailView } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestDetailView');
const { EnterpriseRequestStateCard } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestStateCard');
const { readRequestListView } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/requestListQuery');

const C = en.billing.contactSales;
const P = en.platformAdmin.enterpriseRequests;

function render(ui: ReactElement) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider
        locale="en"
        messages={en}
        timeZone="UTC"
        now={new Date('2026-10-08T12:00:00.000Z')}
      >
        {children}
      </NextIntlClientProvider>
    );
  }
  return rtlRender(ui, { wrapper: Wrapper });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  transitionEnterpriseRequestAction.mockClear();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function orgRequest(over: Partial<EnterpriseRequestDTO> = {}): EnterpriseRequestDTO {
  return {
    id: 'req1',
    status: 'received',
    createdAt: '2026-10-05T10:00:00.000Z',
    cardsPerDay: 40,
    parallelAgents: 8,
    agentPath: 'own',
    autonomy: 'autonomous_lead',
    startWhen: 'within_month',
    teamSize: 'size_11_50',
    contact: 'sam@moooon.example',
    note: 'Run our repositories overnight.',
    requestedByName: 'Sam Rivera',
    ...over,
  };
}

// ── the Contact-sales dialog, opened directly ────────────────────────────────

function renderDialog(
  opts: {
    context?: { requesterName: string; requesterEmail: string; repositoryCount: number } | null;
    planName?: string | null;
    openRequest?: EnterpriseRequestDTO | null;
    onRequestChanged?: () => Promise<EnterpriseRequestDTO | null | undefined>;
  } = {},
) {
  const onOpenChange = vi.fn();
  const onRequestChanged = vi.fn(opts.onRequestChanged ?? (async () => undefined));
  render(
    <ContactSalesDialog
      open
      onOpenChange={onOpenChange}
      orgId="org1"
      orgName="Acme"
      planName={opts.planName === undefined ? 'Standard' : opts.planName}
      context={opts.context === undefined ? null : opts.context}
      openRequest={opts.openRequest ?? null}
      onRequestChanged={onRequestChanged}
    />,
  );
  return { onOpenChange, onRequestChanged };
}

const dialog = () => screen.getByRole('dialog');
const note = () => within(dialog()).getByRole('textbox', { name: /^Note/ });
const spin = (name: string) => within(dialog()).getByRole('spinbutton', { name });
const send = () => within(dialog()).getByRole('button', { name: C.send });

function stubPost(answer: () => Promise<Response> | Response) {
  const fetchMock = vi.fn(async () => answer());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the Contact-sales dialog, at its edges', () => {
  it('with no page context and no plan, the read-only box says "—" and the contact starts blank (sent as null)', async () => {
    const fetchMock = stubPost(() => json(orgRequest(), 201));
    const { onRequestChanged } = renderDialog({ context: null, planName: null });

    const facts = screen.getByTestId('contact-sales-facts');
    expect(facts.textContent).toContain('Acme');
    expect(facts.textContent?.match(/—/g)).toHaveLength(3);

    const contact = within(dialog()).getByRole('textbox', { name: /Best way to reach you/ });
    expect((contact as HTMLInputElement).value).toBe('');
    fireEvent.change(contact, { target: { value: '   ' } });
    fireEvent.change(note(), { target: { value: 'Call us.' } });
    await act(async () => fireEvent.click(send()));

    const body = JSON.parse(
      (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.contact).toBeNull();
    // The re-read came back unknown, so the dialog confirms with the POST's own answer.
    expect(onRequestChanged).toHaveBeenCalledTimes(1);
    const sent = await screen.findByRole('dialog', { name: C.sent.title });
    expect(within(sent).getByText('sam@moooon.example')).toBeTruthy();
  });

  it('refuses a count that is not a whole number ≥ 1, focusing the first bad field in reading order', async () => {
    const fetchMock = stubPost(() => json(orgRequest(), 201));
    renderDialog();
    fireEvent.change(note(), { target: { value: 'x' } });

    fireEvent.change(spin(C.fields.cardsPerDay), { target: { value: '0' } });
    fireEvent.change(spin(C.fields.parallelAgents), { target: { value: '2.5' } });
    fireEvent.click(send());
    expect(within(dialog()).getAllByText(C.errors.number)).toHaveLength(2);
    expect(document.activeElement).toBe(spin(C.fields.cardsPerDay));

    // Only the second wrong: focus lands there.
    fireEvent.change(spin(C.fields.cardsPerDay), { target: { value: '12' } });
    fireEvent.click(send());
    expect(within(dialog()).getAllByText(C.errors.number)).toHaveLength(1);
    expect(document.activeElement).toBe(spin(C.fields.parallelAgents));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['note', C.errors.note],
    ['cardsPerDay', C.errors.number],
  ] as const)('a server 400 on %s shows that field’s message', async (field, message) => {
    stubPost(() => json({ code: 'ENTERPRISE_REQUEST_INVALID', field }, 400));
    renderDialog();
    fireEvent.change(note(), { target: { value: 'x' } });
    await act(async () => fireEvent.click(send()));
    expect(within(dialog()).getByText(message)).toBeTruthy();
    // A field message, not a refusal box: Send stays enabled to correct and retry.
    expect(dialog().textContent).not.toContain(C.refused.network.title);
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it('a server 400 on a field the form does not draw reads as the network refusal — nothing was sent', async () => {
    stubPost(() => json({ code: 'ENTERPRISE_REQUEST_INVALID', field: 'agentPath' }, 400));
    renderDialog();
    fireEvent.change(note(), { target: { value: 'x' } });
    await act(async () => fireEvent.click(send()));
    expect(within(dialog()).getByRole('alert').textContent).toContain(C.refused.network.title);
  });

  it('a 409 whose winner cannot be re-read says so without a date, and offers no View', async () => {
    stubPost(() => json({ code: 'ENTERPRISE_REQUEST_OPEN', openRequestId: 'req1' }, 409));
    renderDialog({ onRequestChanged: async () => undefined });
    fireEvent.change(note(), { target: { value: 'x' } });
    await act(async () => fireEvent.click(send()));
    const alert = within(dialog()).getByRole('alert');
    expect(alert.textContent).toContain(C.refused.open.bodyNoDate);
    expect(within(alert).queryByRole('button', { name: C.refused.open.action })).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot be dismissed while sending; Cancel closes it once the answer lands', async () => {
    let answer!: (r: Response) => void;
    stubPost(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { onOpenChange } = renderDialog();
    fireEvent.change(note(), { target: { value: 'x' } });
    fireEvent.click(send());

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    // A second press while in flight sends nothing more.
    fireEvent.click(within(dialog()).getByRole('button', { name: /Sending/ }));

    await act(async () => answer(json({ code: 'BOOM' }, 500)));
    expect(within(dialog()).getByRole('alert').textContent).toContain(C.refused.network.title);
    fireEvent.click(within(dialog()).getByRole('button', { name: C.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('two presses inside one render send twice, and only the LATEST answer is applied (the seq guard)', async () => {
    const answers: Array<(r: Response) => void> = [];
    const fetchMock = stubPost(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const changed: Array<(r: EnterpriseRequestDTO | null) => void> = [];
    renderDialog({
      onRequestChanged: () => new Promise((resolve) => changed.push(resolve)),
    });
    fireEvent.change(note(), { target: { value: 'x' } });
    const button = send();
    // Both handlers run against the same render, before `sending` re-renders.
    act(() => {
      button.click();
      button.click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The older send answers first: dropped — no re-read, no state.
    await act(async () => answers[0]!(json({ code: 'ENTERPRISE_REQUEST_OPEN' }, 409)));
    expect(changed).toHaveLength(0);
    expect(within(dialog()).queryByRole('alert')).toBeNull();

    // The newer one is the one that counts.
    await act(async () => answers[1]!(json(orgRequest({ contact: 'new@acme.example' }), 201)));
    expect(changed).toHaveLength(1);
    await act(async () => changed[0]!(orgRequest()));
    const sent = await screen.findByRole('dialog', { name: C.sent.title });
    expect(within(sent).getByText('new@acme.example')).toBeTruthy();
  });

  it('a re-read that is overtaken by a newer send is dropped too (sent and 409 alike)', async () => {
    const answers: Array<(r: Response) => void> = [];
    stubPost(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const changed: Array<(r: EnterpriseRequestDTO | null) => void> = [];
    renderDialog({ onRequestChanged: () => new Promise((resolve) => changed.push(resolve)) });
    fireEvent.change(note(), { target: { value: 'x' } });
    const button = send();
    act(() => {
      button.click();
      button.click();
    });
    // Both POSTs answer before either re-read does; the older one's re-read is
    // then overtaken, and its answer must not land.
    await act(async () => answers[1]!(json({ code: 'ENTERPRISE_REQUEST_OPEN' }, 409)));
    await act(async () => answers[0]!(json(orgRequest(), 201)));
    expect(changed).toHaveLength(1);
    await act(async () => changed[0]!(null));
    // The 409's re-read found nothing: the no-date refusal, not a sent dialog.
    expect(screen.queryByRole('dialog', { name: C.sent.title })).toBeNull();
    expect(within(dialog()).getByRole('alert').textContent).toContain(C.refused.open.bodyNoDate);
  });

  it('a closed request with every answer blank and no sender reads as such, with no state pill', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { onOpenChange } = renderDialog({
      openRequest: orgRequest({
        status: 'closed',
        cardsPerDay: null,
        parallelAgents: null,
        agentPath: null,
        autonomy: null,
        startWhen: null,
        teamSize: null,
        requestedByName: null,
      }),
    });
    const view = screen.getByRole('dialog', { name: C.request.title });
    expect(view.textContent).toContain('Sent Oct 5, 2026.');
    expect(within(view).getAllByText(C.request.unset)).toHaveLength(6);
    expect(within(view).queryByText(C.request.state)).toBeNull();
    fireEvent.keyDown(view, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ── the browser client's folded answers ──────────────────────────────────────

describe('the browser client (lib/billing/enterpriseRequestClient)', () => {
  const ok = orgRequest();

  it.each([
    ['a refusal', () => json({ code: 'BILLING_FORBIDDEN' }, 403), undefined],
    ['nothing open', () => json(null), null],
    ['the open request', () => json(ok), ok],
    ['an unexpected object', () => json({ id: 1 }), undefined],
    ['a non-object body', () => json(5), undefined],
    ['a network failure', () => Promise.reject(new TypeError('offline')), undefined],
  ] as const)('GET folds %s', async (_label, answer, expected) => {
    vi.stubGlobal('fetch', vi.fn(answer as () => Promise<Response>));
    expect(await fetchOpenEnterpriseRequest('org/1')).toEqual(expected);
  });

  it('GET encodes the org id into the path', async () => {
    const fetchMock = vi.fn(async () => json(null));
    vi.stubGlobal('fetch', fetchMock);
    await fetchOpenEnterpriseRequest('org/1');
    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/org%2F1/billing/enterprise-request');
  });

  it.each([
    ['201 with the request', () => json(ok, 201), { kind: 'sent', request: ok }],
    ['201 with an unexpected body', () => json({ id: 'x' }, 201), { kind: 'error' }],
    ['a non-JSON answer', () => new Response('<html>', { status: 502 }), { kind: 'error' }],
    [
      '409 naming the open request',
      () => json({ code: 'ENTERPRISE_REQUEST_OPEN', openRequestId: 'req1' }, 409),
      { kind: 'already_open', openRequestId: 'req1' },
    ],
    [
      '409 without an id',
      () => json({ code: 'ENTERPRISE_REQUEST_OPEN' }, 409),
      { kind: 'already_open', openRequestId: null },
    ],
    ['a 409 of another kind', () => json({ code: 'ORGANIZATION_CLOSING' }, 409), { kind: 'error' }],
    ['403', () => json({ code: 'BILLING_FORBIDDEN' }, 403), { kind: 'forbidden' }],
    ['400 naming a field', () => json({ field: 'note' }, 400), { kind: 'invalid', field: 'note' }],
    ['400 naming nothing', () => json({ code: 'X' }, 400), { kind: 'error' }],
    ['a network failure', () => Promise.reject(new TypeError('offline')), { kind: 'error' }],
  ] as const)('POST folds %s', async (_label, answer, expected) => {
    vi.stubGlobal('fetch', vi.fn(answer as () => Promise<Response>));
    expect(await sendEnterpriseRequest('org1', { note: 'x' })).toEqual(expected);
  });
});

// ── the console, with blank answers ──────────────────────────────────────────

function staffRequest(
  over: Partial<PlatformEnterpriseRequestDTO> = {},
): PlatformEnterpriseRequestDTO {
  return {
    id: 'cmreq0000000000000000009',
    status: 'new',
    organizationId: 'org_acme',
    organizationName: 'Acme Corp',
    tierKeyAtRequest: null,
    requester: null,
    contact: '',
    note: 'Call us.',
    cardsPerDay: null,
    parallelAgents: null,
    agentPath: null,
    autonomy: null,
    startWhen: 'within_quarter',
    teamSize: null,
    createdAt: '2026-10-05T11:58:00.000Z',
    closedAt: null,
    ...over,
  };
}

describe('the console, with the answers an org may leave blank', () => {
  it('the detail reads every blank as Not answered, and the answered start date as itself', () => {
    render(
      <EnterpriseRequestDetailView
        detail={{ request: staffRequest(), history: [], moves: [] }}
        stateCard={null}
      />,
    );
    const body = screen.getByTestId('enterprise-request-body');
    const field = (key: string) => body.querySelector(`[data-field="${key}"]`)?.textContent;
    for (const key of [
      'contact',
      'cardsPerDay',
      'parallelAgents',
      'agentPath',
      'autonomy',
      'teamSize',
    ]) {
      expect(field(key), key).toBe(P.notAnswered);
    }
    expect(field('startWhen')).toBe(P.startWhen.within_quarter);
  });

  it('a list row with no requester and no answers says so in both layouts', () => {
    const page: PlatformEnterpriseRequestPageDTO = {
      filter: 'open',
      requests: [staffRequest()],
      total: 1,
      counts: { open: 1, new: 1, contacted: 0, offer_sent: 0, won: 0, lost: 0, all: 1 },
      nextCursor: null,
      pageSize: 50,
    };
    render(<EnterpriseRequestsCard page={page} view={{ filter: 'open', cursors: [] }} />);
    const row = screen.getByTestId('enterprise-request-row-cmreq0000000000000000009');
    expect(row.textContent).toContain(P.requesterGone);
    const narrow = screen.getByTestId('enterprise-requests-list-narrow');
    expect(narrow.textContent).toContain(`${P.requesterGone} ·`);
    const needs = within(row).getByTestId('enterprise-request-needs').textContent;
    for (const none of ['items/day —', 'agents —', 'which agents —', 'on its own —']) {
      expect(needs).toContain(none);
    }
  });

  it('a closed request with no close date reads "—" for the date', () => {
    render(
      <EnterpriseRequestStateCard
        requestId="r1"
        organizationId="org_acme"
        organizationName="Acme Corp"
        status="lost"
        moves={[]}
        closedAt={null}
        canMove
      />,
    );
    expect(screen.getByTestId('enterprise-request-closed').textContent).toContain(
      'Closed as Lost on —.',
    );
  });

  it('Escape on the close confirm cancels it — nothing moves', async () => {
    render(
      <EnterpriseRequestStateCard
        requestId="r1"
        organizationId="org_acme"
        organizationName="Acme Corp"
        status={'offer_sent' as EnterpriseRequestStatusValue}
        moves={['won', 'lost']}
        closedAt={null}
        canMove
      />,
    );
    fireEvent.click(screen.getByTestId('enterprise-request-move-won'));
    const confirm = screen.getByRole('alertdialog');
    fireEvent.keyDown(confirm, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(transitionEnterpriseRequestAction).not.toHaveBeenCalled();
  });

  it('the list view reads the first value of a repeated query parameter', () => {
    expect(readRequestListView({ state: ['won', 'lost'], c: undefined })).toEqual({
      filter: 'won',
      cursors: [],
    });
  });
});
