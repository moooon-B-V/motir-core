// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type {
  EnterpriseRequestFilter,
  EnterpriseRequestStatusValue,
  PlatformEnterpriseRequestDTO,
  PlatformEnterpriseRequestDetailDTO,
  PlatformEnterpriseRequestPageDTO,
} from '@/lib/dto/platformEnterpriseRequest';

/**
 * The ENTERPRISE REQUESTS console's pieces (Story MOTIR-7602 · MOTIR-7609,
 * design `platform-admin/design-notes.md` § Enterprise requests). Each case is a
 * state the design draws, rendered from a DTO with the real `en` catalogue. The
 * move action is stubbed: its codes have their own suite
 * (`tests/platform/enterpriseRequestActions.test.ts`); here each code is driven
 * to what the page shows for it.
 */

const transitionEnterpriseRequestAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock('@/app/(admin)/admin/enterprise-requests/actions', () => ({
  transitionEnterpriseRequestAction,
}));
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const { EnterpriseRequestsCard, NoRequestsYet } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestsCard');
const { EnterpriseRequestsSkeleton } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestsSkeleton');
const { EnterpriseRequestsUnavailable } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestsUnavailable');
const { EnterpriseRequestDetailView } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestDetailView');
const { EnterpriseRequestStateCard } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestStateCard');

const NOW = new Date('2026-10-05T14:00:00.000Z');

/** The real catalogue, the production `timeZone` (UTC) and a pinned `now`. */
function render(
  ui: ReactElement,
  { locale = 'en', messages = en as Record<string, unknown>, now = NOW } = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC" now={now}>
        {children}
      </NextIntlClientProvider>
    );
  }
  return rtlRender(ui, { wrapper: Wrapper });
}

afterEach(() => {
  cleanup();
  transitionEnterpriseRequestAction.mockClear();
  push.mockClear();
  refresh.mockClear();
});

function request(over: Partial<PlatformEnterpriseRequestDTO> = {}): PlatformEnterpriseRequestDTO {
  return {
    id: 'cmreq0000000000000000001',
    status: 'new',
    organizationId: 'org_acme',
    organizationName: 'Acme Corp',
    tierKeyAtRequest: 'team',
    requester: { id: 'u1', name: 'Dana Whitfield', email: 'dana@acme.example' },
    contact: 'dana.whitfield@acme.example · +31 20 555 0142',
    note: 'Happy to talk this week.',
    cardsPerDay: 40,
    parallelAgents: 8,
    agentPath: 'both',
    autonomy: 'autonomous_lead',
    startWhen: null,
    teamSize: 'size_51_200',
    createdAt: '2026-10-05T11:58:00.000Z',
    closedAt: null,
    ...over,
  };
}

const COUNTS: Record<EnterpriseRequestFilter, number> = {
  open: 63,
  new: 21,
  contacted: 30,
  offer_sent: 12,
  won: 0,
  lost: 9,
  all: 72,
};

function page(
  over: Partial<PlatformEnterpriseRequestPageDTO> = {},
): PlatformEnterpriseRequestPageDTO {
  return {
    filter: 'open',
    requests: [
      request(),
      request({
        id: 'cmreq0000000000000000002',
        organizationName: 'Globex',
        tierKeyAtRequest: null,
        status: 'contacted',
        cardsPerDay: null,
        autonomy: null,
        agentPath: 'hosted',
        parallelAgents: 4,
        requester: { id: 'u2', name: 'Priya Raman', email: 'priya@globex.example' },
      }),
    ],
    total: 63,
    counts: COUNTS,
    nextCursor: 'cmreq0000000000000000002',
    pageSize: 50,
    ...over,
  };
}

function detail(
  status: EnterpriseRequestStatusValue,
  over: Partial<PlatformEnterpriseRequestDetailDTO> = {},
): PlatformEnterpriseRequestDetailDTO {
  return {
    request: request({
      status,
      closedAt: status === 'won' || status === 'lost' ? '2026-10-17T16:05:00.000Z' : null,
    }),
    history: [],
    moves: [],
    ...over,
  };
}

const LEGAL: Record<EnterpriseRequestStatusValue, EnterpriseRequestStatusValue[]> = {
  new: ['contacted', 'lost'],
  contacted: ['offer_sent', 'lost'],
  offer_sent: ['won', 'lost'],
  won: [],
  lost: [],
};

function stateCard(
  status: EnterpriseRequestStatusValue,
  opts: { canMove?: boolean; moves?: EnterpriseRequestStatusValue[] } = {},
) {
  const canMove = opts.canMove ?? true;
  return (
    <EnterpriseRequestStateCard
      requestId="cmreq0000000000000000001"
      organizationId="org_acme"
      organizationName="Acme Corp"
      status={status}
      moves={opts.moves ?? (canMove ? LEGAL[status] : [])}
      closedAt={status === 'won' || status === 'lost' ? '2026-10-17T16:05:00.000Z' : null}
      canMove={canMove}
    />
  );
}

const moveButtons = () =>
  within(screen.getByTestId('enterprise-request-state-card'))
    .queryAllByRole('button')
    .map((b) => b.textContent);

describe('the list (Panels 1–2)', () => {
  it('renders the drawn columns, the count, the filter with counts and the pager', () => {
    render(<EnterpriseRequestsCard page={page()} view={{ filter: 'open', cursors: [] }} />);

    expect(screen.getByTestId('enterprise-requests-count').textContent).toBe(
      'Newest first. 63 open — new, contacted or offer sent.',
    );
    const table = screen.getByTestId('enterprise-requests-table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Organisation', 'Requester', 'Sent', 'Needs', 'State']);

    const acme = screen.getByTestId('enterprise-request-row-cmreq0000000000000000001');
    expect(acme.textContent).toContain('on Team when sent');
    expect(acme.textContent).toContain('dana@acme.example');
    expect(acme.textContent).toContain('2 hours ago');
    expect(acme.textContent).toContain('40 items/day');
    expect(acme.textContent).toContain('8 agents');
    expect(acme.textContent).toContain('Runs on its own');
    expect(within(acme).getByRole('link', { name: 'Acme Corp' }).getAttribute('href')).toBe(
      '/admin/enterprise-requests/cmreq0000000000000000001',
    );
    expect(acme.getAttribute('data-status')).toBe('new');

    // An unanswered need reads `{unit} —`; no tier at request omits the line.
    const globex = screen.getByTestId('enterprise-request-row-cmreq0000000000000000002');
    expect(globex.textContent).toContain('items/day —');
    expect(globex.textContent).toContain('on its own —');
    expect(globex.textContent).toContain('Motir-hosted');
    expect(globex.textContent).not.toContain('when sent');
    expect(globex.textContent).toContain('Contacted');

    // The filter: seven segments, each carrying its count, Open pressed.
    const filter = screen.getByRole('group', { name: 'Filter requests by state' });
    const segments = within(filter).getAllByRole('button');
    expect(segments.map((s) => s.textContent)).toEqual([
      'Open63',
      'New21',
      'Contacted30',
      'Offer sent12',
      'Won0',
      'Lost9',
      'All72',
    ]);
    expect(segments[0]!.getAttribute('aria-pressed')).toBe('true');

    // The pager: 1–2 of 63, Newer disabled on the first page, Older live.
    const pager = screen.getByRole('navigation', { name: 'Pages of requests' });
    expect(pager.textContent).toContain('Newest first · 50 a page');
    expect(within(pager).getByTestId('enterprise-requests-range').textContent).toBe('1–2 of 63');
    expect(within(pager).queryByRole('link', { name: /Newer/ })).toBeNull();
    expect(within(pager).getByRole('link', { name: /Older/ }).getAttribute('href')).toBe(
      '/admin/enterprise-requests?c=cmreq0000000000000000002',
    );
  });

  it('a filter press pushes the server-answered URL, starting the pager over', () => {
    render(<EnterpriseRequestsCard page={page()} view={{ filter: 'open', cursors: [] }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Lost\s*9$/ }));
    expect(push).toHaveBeenCalledWith('/admin/enterprise-requests?state=lost');
    fireEvent.click(screen.getByRole('button', { name: /^All\s*72$/ }));
    expect(push).toHaveBeenLastCalledWith('/admin/enterprise-requests?state=all');
  });

  it('Panel 2 left: a state filter — its count line and the pager follow it', () => {
    render(
      <EnterpriseRequestsCard
        page={page({
          filter: 'lost',
          total: 9,
          nextCursor: null,
          requests: [request({ status: 'lost', closedAt: '2026-09-01T00:00:00.000Z' })],
        })}
        view={{ filter: 'lost', cursors: [] }}
      />,
    );
    expect(screen.getByTestId('enterprise-requests-count').textContent).toBe(
      'Newest first. 9 lost.',
    );
    expect(screen.getByRole('button', { name: /^Lost\s*9$/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const pager = screen.getByRole('navigation', { name: 'Pages of requests' });
    expect(within(pager).getByTestId('enterprise-requests-range').textContent).toBe('1–1 of 9');
    expect(within(pager).queryAllByRole('link')).toHaveLength(0);
  });

  it('Panel 2 below: a later page — Newer pops the stack, Older is disabled', () => {
    render(
      <EnterpriseRequestsCard
        page={page({ filter: 'all', nextCursor: null, total: 52 })}
        view={{ filter: 'all', cursors: ['cmreq0000000000000000050'] }}
      />,
    );
    expect(screen.getByTestId('enterprise-requests-count').textContent).toBe(
      'Newest first. 52 in all.',
    );
    const pager = screen.getByRole('navigation', { name: 'Pages of requests' });
    expect(within(pager).getByTestId('enterprise-requests-range').textContent).toBe('51–52 of 52');
    expect(within(pager).getByRole('link', { name: /Newer/ }).getAttribute('href')).toBe(
      '/admin/enterprise-requests?state=all',
    );
    expect(within(pager).queryByRole('link', { name: /Older/ })).toBeNull();
  });

  it('Panel 2 right: a filter with nothing in it is the filter-shaped empty state', () => {
    render(
      <EnterpriseRequestsCard
        page={page({ filter: 'won', total: 0, requests: [], nextCursor: null })}
        view={{ filter: 'won', cursors: [] }}
      />,
    );
    const empty = screen.getByTestId('enterprise-requests-no-match');
    expect(empty.textContent).toContain('No won requests');
    expect(empty.textContent).toContain('No request is won right now.');
    expect(
      within(empty).getByRole('link', { name: 'Show open requests' }).getAttribute('href'),
    ).toBe('/admin/enterprise-requests');
    // The card and its filter stay; there is no table and no pager.
    expect(screen.getByRole('group', { name: 'Filter requests by state' })).toBeTruthy();
    expect(screen.queryByTestId('enterprise-requests-table')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Pages of requests' })).toBeNull();
    expect(screen.queryByTestId('enterprise-requests-empty')).toBeNull();
  });

  it('an empty Open filter offers All rather than itself', () => {
    render(
      <EnterpriseRequestsCard
        page={page({ filter: 'open', total: 0, requests: [], nextCursor: null })}
        view={{ filter: 'open', cursors: [] }}
      />,
    );
    const empty = screen.getByTestId('enterprise-requests-no-match');
    expect(empty.textContent).toContain('No open requests');
    expect(
      within(empty).getByRole('link', { name: 'Show all requests' }).getAttribute('href'),
    ).toBe('/admin/enterprise-requests?state=all');
  });
});

describe('the list states (Panel 3)', () => {
  it('(a) loading: the card, title and filter paint; no count is guessed; rows are busy', () => {
    render(<EnterpriseRequestsSkeleton filter="lost" />);
    expect(screen.getByTestId('enterprise-requests-count').textContent).toBe('Newest first.');
    const segments = within(
      screen.getByRole('group', { name: 'Filter requests by state' }),
    ).getAllByRole('button');
    expect(segments.map((s) => s.textContent)).toEqual([
      'Open',
      'New',
      'Contacted',
      'Offer sent',
      'Won',
      'Lost',
      'All',
    ]);
    expect(screen.getByRole('button', { name: 'Lost' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('enterprise-requests-loading').getAttribute('aria-busy')).toBe(
      'true',
    );
  });

  it('(b) empty: nothing ever sent, no filter to clear', () => {
    render(<NoRequestsYet />);
    const empty = screen.getByTestId('enterprise-requests-empty');
    expect(empty.textContent).toContain('No enterprise requests yet');
    expect(empty.textContent).toContain('platform staff are emailed');
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('(c) error: the error card with Retry, which re-runs the server read', async () => {
    render(<EnterpriseRequestsUnavailable />);
    const card = screen.getByTestId('enterprise-requests-unavailable');
    expect(card.textContent).toContain('Couldn’t load the requests');
    expect(card.textContent).toContain('Nothing has changed.');
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('the detail (Panels 4, 6)', () => {
  it('renders the request, the org link to its tenant page, and History oldest first', () => {
    const d = detail('won', {
      history: [
        move('new', 'contacted', 'sam@moooon.net', '2026-10-05T14:10:00.000Z'),
        move('contacted', 'offer_sent', 'lena@moooon.net', '2026-10-08T09:42:00.000Z'),
        move('offer_sent', 'won', 'lena@moooon.net', '2026-10-17T16:05:00.000Z'),
      ],
    });
    render(<EnterpriseRequestDetailView detail={d} stateCard={<p>state</p>} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Acme Corp' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to requests' }).getAttribute('href')).toBe(
      '/admin/enterprise-requests',
    );
    expect(screen.getByText('Sent Oct 5, 2026')).toBeTruthy();

    const org = screen.getByRole('link', { name: 'Open Acme Corp in Tenants' });
    expect(org.getAttribute('href')).toBe('/admin/tenants/org_acme');

    const body = screen.getByTestId('enterprise-request-body');
    const field = (key: string) => body.querySelector(`[data-field="${key}"]`)?.textContent;
    expect(field('organisation')).toBe('Acme Corp · on Team when sent');
    expect(field('requester')).toBe('Dana Whitfield · dana@acme.example');
    expect(field('contact')).toBe('dana.whitfield@acme.example · +31 20 555 0142');
    expect(field('cardsPerDay')).toBe('40');
    expect(field('parallelAgents')).toBe('8');
    expect(field('agentPath')).toBe('Both');
    expect(field('autonomy')).toBe('Runs on its own');
    expect(field('startWhen')).toBe('Not answered');
    expect(field('teamSize')).toBe('51–200');
    expect(screen.getByTestId('enterprise-request-note').textContent).toBe(
      'Happy to talk this week.',
    );

    const entries = screen.getAllByTestId('enterprise-request-history-entry');
    expect(entries).toHaveLength(4);
    expect(entries[0]!.textContent).toContain('Sent as');
    expect(entries[0]!.textContent).toContain('Dana Whitfield (Acme Corp)');
    expect(entries[1]!.textContent).toContain('NewContacted');
    expect(entries[1]!.textContent).toContain('sam@moooon.net');
    expect(within(entries[1]!).getByRole('img', { name: 'to' })).toBeTruthy();
    expect(entries[3]!.textContent).toContain('Offer sentWon');
    expect(entries[3]!.textContent).toContain('lena@moooon.net');
    // No price anywhere on the page.
    expect(document.body.textContent).not.toMatch(/[$€£]/);
  });

  it('a deleted requester and an empty note read as such, not as gaps', () => {
    const d = detail('new');
    d.request = { ...d.request, requester: null, note: '', tierKeyAtRequest: null };
    render(<EnterpriseRequestDetailView detail={d} stateCard={null} />);
    const body = screen.getByTestId('enterprise-request-body');
    expect(body.querySelector('[data-field="requester"]')?.textContent).toBe('Account deleted');
    expect(body.querySelector('[data-field="organisation"]')?.textContent).toBe('Acme Corp');
    expect(screen.queryByTestId('enterprise-request-note')).toBeNull();
    expect(body.textContent).toContain('Not answered');
    expect(screen.getAllByTestId('enterprise-request-history-entry')[0]!.textContent).toContain(
      'Acme Corp ·',
    );
  });
});

function move(
  from: EnterpriseRequestStatusValue,
  to: EnterpriseRequestStatusValue,
  email: string,
  at: string,
) {
  return { from, to, actorUserId: email, actorName: email, actorEmail: email, at };
}

describe('the state card (Panels 5, 7, 8)', () => {
  it.each([
    ['new', ['Mark contacted', 'Mark lost'], 'Next: you reached out to the requester.'],
    ['contacted', ['Mark offer sent', 'Mark lost'], 'Next: you sent them an offer.'],
    ['offer_sent', ['Mark won', 'Mark lost'], 'Next: they accepted — or it is lost.'],
  ] as const)('%s: exactly the legal next states, with the hint', (status, buttons, hint) => {
    render(stateCard(status));
    const card = screen.getByTestId('enterprise-request-state-card');
    expect(within(card).getByRole('heading', { name: 'Move to' })).toBeTruthy();
    expect(moveButtons()).toEqual([...buttons]);
    expect(card.textContent).toContain(`${hint} Won and lost close the request.`);
  });

  it.each([
    ['won', 'Closed as Won on Oct 17, 2026.'],
    ['lost', 'Closed as Lost on Oct 17, 2026.'],
  ] as const)('%s: closed — no control, the closing line', (status, line) => {
    render(stateCard(status));
    const card = screen.getByTestId('enterprise-request-state-card');
    expect(within(card).getByRole('heading', { name: 'State' })).toBeTruthy();
    expect(moveButtons()).toEqual([]);
    expect(screen.getByTestId('enterprise-request-closed').textContent).toContain(line);
    expect(card.textContent).toContain(
      'The organisation can send a new one from its Billing page.',
    );
  });

  it.each(['new', 'contacted', 'offer_sent'] as const)(
    'a support viewer on a %s request: read-only, no control at all',
    (status) => {
      render(stateCard(status, { canMove: false }));
      expect(moveButtons()).toEqual([]);
      expect(screen.getByTestId('enterprise-request-read-only').textContent).toContain(
        'Read-only for support.',
      );
      expect(screen.queryByTestId('enterprise-request-closed')).toBeNull();
    },
  );

  it('a support viewer on a closed request sees the closing line', () => {
    render(stateCard('won', { canMove: false }));
    expect(screen.getByTestId('enterprise-request-closed')).toBeTruthy();
    expect(screen.queryByTestId('enterprise-request-read-only')).toBeNull();
  });

  it('an open move applies on one press and re-reads from the server', async () => {
    const view = render(stateCard('new'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark contacted' }));
    });
    expect(transitionEnterpriseRequestAction).toHaveBeenCalledWith(
      'cmreq0000000000000000001',
      'org_acme',
      'new',
      'contacted',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The action revalidates the detail; the re-read arrives as new props.
    view.rerender(stateCard('contacted'));
    expect(moveButtons()).toEqual(['Mark offer sent', 'Mark lost']);
  });

  it.each([
    ['won', 'offer_sent', 'Mark won', 'Mark this request won?', 'Won'],
    ['lost', 'new', 'Mark lost', 'Mark this request lost?', 'Lost'],
  ] as const)(
    'Mark %s asks once in an alertdialog before it closes the request',
    async (to, from, label, title, pill) => {
      render(stateCard(from));
      fireEvent.click(screen.getByRole('button', { name: label }));
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(title)).toBeTruthy();
      expect(dialog.textContent).toContain(
        `Acme Corp’s request closes as ${pill} and cannot be moved again.`,
      );
      expect(transitionEnterpriseRequestAction).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(transitionEnterpriseRequestAction).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: label }));
      const again = await screen.findByRole('alertdialog');
      await act(async () => {
        fireEvent.click(within(again).getByRole('button', { name: label }));
      });
      expect(transitionEnterpriseRequestAction).toHaveBeenCalledWith(
        'cmreq0000000000000000001',
        'org_acme',
        from,
        to,
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();
    },
  );

  it('Panel 8 right: a stale move names who moved it and to what, over the re-read state', async () => {
    transitionEnterpriseRequestAction.mockResolvedValueOnce({
      ok: false,
      code: 'STALE',
      currentStatus: 'offer_sent',
      movedBy: { userId: 'u9', email: 'lena@moooon.net' },
    });
    const view = render(stateCard('new'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark contacted' }));
    });
    view.rerender(stateCard('offer_sent'));
    expect(screen.getByRole('alert').textContent).toBe(
      'Not changed — someone else moved this request first. lena@moooon.net marked it Offer sent ' +
        'a moment ago, so your “Mark contacted” was refused and nothing was recorded. The page ' +
        'now shows its current state; choose again.',
    );
    expect(moveButtons()).toEqual(['Mark won', 'Mark lost']);
  });

  it('a stale move with nobody newer reads "It is now …"', async () => {
    transitionEnterpriseRequestAction.mockResolvedValueOnce({
      ok: false,
      code: 'STALE',
      currentStatus: 'lost',
      movedBy: null,
    });
    render(stateCard('contacted'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark offer sent' }));
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'It is now Lost, so your “Mark offer sent” was refused',
    );
  });

  it('any other refusal says nothing changed', async () => {
    transitionEnterpriseRequestAction.mockResolvedValueOnce({ ok: false, code: 'FAILED' });
    render(stateCard('new'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark contacted' }));
    });
    expect(screen.getByTestId('enterprise-request-move-failed').textContent).toBe(
      'Couldn’t move the request. Nothing changed; try again.',
    );
  });
});

describe('zh', () => {
  it('renders the state card and the list in Chinese', () => {
    render(stateCard('new'), { locale: 'zh', messages: zh });
    expect(moveButtons()).toEqual(['标记为已联系', '标记为已流失']);
    cleanup();
    render(<EnterpriseRequestsCard page={page()} view={{ filter: 'open', cursors: [] }} />, {
      locale: 'zh',
      messages: zh,
    });
    expect(screen.getByTestId('enterprise-requests-count').textContent).toBe(
      '最新的在前。63 条进行中。',
    );
  });
});
