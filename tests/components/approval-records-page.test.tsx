// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { ApprovalRecordsPageDto } from '@/lib/dto/approvalGate';

// THE /approvals ROUTE (Story MOTIR-5299 · the story gate, MOTIR-5303) — the real
// page module rendered, with the session, the active project and the READ stubbed
// at their module boundaries. The read's own suites prove what it returns; this
// file proves what the page does with it:
//
//   · it hands the read ONLY the page number from the URL;
//   · the three EMPTY states are distinct, and none of them is permission-shaped —
//     asserted by the absence of the product's access-denied strings, by key;
//   · the subtitle follows the read's `fullView`, never a check of its own.

const { getSession, redirect, getActiveProject, listRecords, push } = vi.hoisted(() => ({
  push: vi.fn(),
  getSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  getActiveProject: vi.fn(),
  listRecords: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/approvals',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/approvalGatesService', () => ({
  approvalGatesService: { listRecords },
}));

const CTX = { userId: 'u1', workspaceId: 'ws1', projectId: 'p1' };

function empty(fullView: boolean): ApprovalRecordsPageDto {
  return {
    fullView,
    sections: { awaiting: { items: [], total: 0 }, decided: { items: [], total: 0 } },
    total: 0,
    page: 1,
    pageSize: 25,
  };
}

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  const mod = await import('@/app/(authed)/approvals/page');
  const tree = (await mod.default({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
  render(tree);
}

/** Every access-denied sentence the product already ships, so none can leak in here. */
const ACCESS_DENIED = [
  en.projectAccess.noAccessTitle,
  en.triage.noAccessDescription,
  en.issueViews.refNoAccessTitle,
];

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(CTX);
  listRecords.mockResolvedValue(empty(false));
});
afterEach(cleanup);

describe('the /approvals page', () => {
  it('redirects a request with no session before it reads anything', async () => {
    getSession.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('redirect:/sign-in');
    expect(listRecords).not.toHaveBeenCalled();
  });

  it('redirects when no active project resolves', async () => {
    getActiveProject.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('redirect:/sign-in');
    expect(listRecords).not.toHaveBeenCalled();
  });

  it('hands the read the page number and NOTHING else from the URL', async () => {
    await renderPage({ page: '3', userId: 'someone-else', fullView: 'true', scope: 'project' });
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(listRecords).toHaveBeenCalledWith(CTX, { page: 3 });
  });

  it('a reader with no records reads "no approvals yet" in their own words — never an access message', async () => {
    await renderPage();
    expect(
      screen.getByRole('heading', { name: en.approvalRecords.heading, level: 1 }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.empty.title)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.empty.bodyOwn)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.subtitle.own)).toBeTruthy();
    for (const denied of ACCESS_DENIED) expect(screen.queryByText(denied)).toBeNull();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/permission|access|administrator/);
  });

  it('the full view’s nothing-at-all state is its own sentence', async () => {
    listRecords.mockResolvedValue(empty(true));
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.bodyFull)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.subtitle.full)).toBeTruthy();
    expect(screen.queryByText(en.approvalRecords.empty.bodyOwn)).toBeNull();
  });

  it('nothing pending and nothing decided are two DIFFERENT lines, neither permission-shaped', async () => {
    const decidedOnly: ApprovalRecordsPageDto = {
      ...empty(false),
      sections: {
        awaiting: { items: [], total: 0 },
        decided: {
          items: [
            {
              gateId: 'g1',
              kind: 'design_result',
              state: 'approved',
              decidedAt: new Date().toISOString(),
              decidedByLabel: 'Me <me@ex.com>',
              decisionSource: null,
              subjectVersion: 'abcdef0123',
              waitingSince: new Date().toISOString(),
              workItem: {
                id: 'w1',
                key: 1,
                identifier: 'MOTIR-1',
                title: 'A decided thing',
                kind: 'subtask',
                type: 'design',
              },
              subject: null,
              confirmedRecord: null,
              chosenOption: null,
            },
          ],
          total: 1,
        },
      },
      total: 1,
    };
    listRecords.mockResolvedValue(decidedOnly);
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.awaitingOwn)).toBeTruthy();
    expect(screen.queryByText(en.approvalRecords.empty.decidedOwn)).toBeNull();
    expect(screen.queryByText(en.approvalRecords.empty.title)).toBeNull();
    cleanup();

    const pendingOnly: ApprovalRecordsPageDto = {
      ...decidedOnly,
      sections: {
        awaiting: {
          items: [
            {
              gateId: 'g2',
              kind: 'design_result',
              state: 'awaiting',
              canDecide: false,
              routedToName: null,
              waitingSince: new Date().toISOString(),
              workItem: {
                id: 'w2',
                key: 2,
                identifier: 'MOTIR-2',
                title: 'A pending thing',
                kind: 'subtask',
                type: 'design',
              },
              subject: null,
            },
          ],
          total: 1,
        },
        decided: { items: [], total: 0 },
      },
    };
    listRecords.mockResolvedValue(pendingOnly);
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.decidedOwn)).toBeTruthy();
    expect(screen.queryByText(en.approvalRecords.empty.awaitingOwn)).toBeNull();
    for (const denied of ACCESS_DENIED) expect(screen.queryByText(denied)).toBeNull();
  });

  // ── The residue the room's own suite left (measured, MOTIR-5303) ──────────
  function decided(over: Record<string, unknown> = {}) {
    return {
      gateId: 'gd',
      kind: 'design_result' as const,
      state: 'approved' as const,
      decidedAt: new Date().toISOString(),
      decidedByLabel: null,
      decisionSource: null,
      subjectVersion: 'abcdef0123',
      waitingSince: new Date().toISOString(),
      workItem: {
        id: 'wd',
        key: 9,
        identifier: 'MOTIR-9',
        title: 'Decided by a departed member',
        kind: 'subtask' as const,
        type: 'design' as const,
      },
      subject: null,
      ...over,
    };
  }
  function awaiting() {
    return {
      gateId: 'ga',
      kind: 'design_result' as const,
      state: 'awaiting' as const,
      canDecide: true,
      routedToName: 'Mara',
      waitingSince: new Date().toISOString(),
      workItem: {
        id: 'wa',
        key: 8,
        identifier: 'MOTIR-8',
        title: 'Waiting thing',
        kind: 'subtask' as const,
        type: 'design' as const,
      },
      subject: null,
    };
  }

  it('in the FULL view, the section empty lines speak for the project, not for the reader', async () => {
    listRecords.mockResolvedValue({
      ...empty(true),
      sections: {
        awaiting: { items: [], total: 0 },
        decided: { items: [decided()], total: 1 },
      },
      total: 1,
    });
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.awaitingFull)).toBeTruthy();
    // A decider whose label was never recorded reads "No one", never blank.
    expect(screen.getAllByText(en.approvalRecords.noOne).length).toBeGreaterThan(0);
    cleanup();

    listRecords.mockResolvedValue({
      ...empty(true),
      sections: {
        awaiting: { items: [awaiting()], total: 1 },
        decided: { items: [], total: 0 },
      },
      total: 1,
    });
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.decidedFull)).toBeTruthy();
  });

  it('a page that ENDS inside the pending half draws no Decided heading — its rows are on a later page', async () => {
    listRecords.mockResolvedValue({
      fullView: false,
      sections: {
        awaiting: { items: [awaiting()], total: 1 },
        decided: { items: [], total: 1 },
      },
      total: 2,
      page: 1,
      pageSize: 1,
    });
    await renderPage();
    expect(screen.getByTestId('approval-records-awaiting')).toBeTruthy();
    expect(screen.queryByTestId('approval-records-decided')).toBeNull();
    // …and the pager moves to the next page of the ROOM.
    fireEvent.click(screen.getByRole('button', { name: en.common.pager.nextPage }));
    expect(push).toHaveBeenCalledWith('/approvals?page=2');
  });
});
