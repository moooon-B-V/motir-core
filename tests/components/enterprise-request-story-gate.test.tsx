// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type {
  EnterpriseRequestStatusValue,
  PlatformEnterpriseRequestDTO,
  PlatformEnterpriseRequestPageDTO,
} from '@/lib/dto/platformEnterpriseRequest';

/**
 * STORY MOTIR-7602's INTEGRATION GATE (MOTIR-7610) — the browser half.
 *
 * The edges the per-card suites left unrendered, each a state a person can
 * reach: the console's detail, list row and state card with the answers an org
 * may leave blank. The server half — seams, race and guards on the real
 * Postgres — is `tests/billing/enterpriseRequestStoryGate.test.ts`.
 *
 * The org-side half (the Contact-sales dialog and its browser client) left
 * with the Enterprise card (MOTIR-7598, decision MOTIR-7592); the request API
 * and this console stay.
 *
 * The one boundary stubbed is the console's server action (the state card);
 * everything rendered is the shipped component with the real `en` catalogue.
 */

const transitionEnterpriseRequestAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock('@/app/(admin)/admin/enterprise-requests/actions', () => ({
  transitionEnterpriseRequestAction,
}));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const { EnterpriseRequestsCard } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestsCard');
const { EnterpriseRequestDetailView } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestDetailView');
const { EnterpriseRequestStateCard } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/EnterpriseRequestStateCard');
const { readRequestListView } =
  await import('@/app/(admin)/admin/enterprise-requests/_components/requestListQuery');

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
