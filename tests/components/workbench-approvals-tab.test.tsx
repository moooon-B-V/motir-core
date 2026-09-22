// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { ApprovalQueueDto, ApprovalQueueRowDto } from '@/lib/dto/approvalGate';

// THE TO-APPROVE TAB's server half (Story MOTIR-5996 · MOTIR-5998) — the real
// `ApprovalsTab` rendered with its READ stubbed at the service boundary. The read's
// own suites prove what it returns (`approval-gate-awaiting-me.test.ts`); this file
// proves what the tab does with it:
//
//   · it asks for the WHOLE set — no page, whatever the URL carried;
//   · the ceiling line appears only when the read says the set was CUT, with the
//     numbers the read gave it;
//   · an empty set still mounts the list, which draws the tab's empty state.

const { listAwaitingMe } = vi.hoisted(() => ({ listAwaitingMe: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/services/approvalGatesService', () => ({
  approvalGatesService: { listAwaitingMe },
}));

const CTX = { userId: 'u1', workspaceId: 'ws1', projectId: 'p1' };

function row(i: number): ApprovalQueueRowDto {
  return {
    gateId: `gate-${i}`,
    kind: 'design_result',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara S.',
    waitingSince: new Date(Date.now() - 86_400_000).toISOString(),
    workItem: {
      id: `wi-${i}`,
      key: 100 + i,
      identifier: `MOTIR-${100 + i}`,
      title: `Waiting ${i}`,
      kind: 'subtask',
      type: 'design',
    },
    subject: {
      kind: 'design_result',
      designEvidenceId: `ev-${i}`,
      producedByKey: null,
      commitSha: '9840d00ea1b2',
      assetCount: 1,
      noteExcerpt: null,
    },
  };
}

async function renderTab(queue: ApprovalQueueDto) {
  listAwaitingMe.mockResolvedValue(queue);
  const { ApprovalsTab } = await import('@/app/(authed)/workbench/_components/ApprovalsTab');
  render((await ApprovalsTab({ ctx: CTX })) as ReactElement);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ApprovalsTab — the whole set, no page (MOTIR-5998)', () => {
  it('asks the read for the WHOLE set — the actor context and nothing else', async () => {
    await renderTab({ items: [row(1), row(2)], total: 2, truncated: false });

    expect(listAwaitingMe).toHaveBeenCalledTimes(1);
    expect(listAwaitingMe.mock.calls[0]).toEqual([CTX]);
    expect(screen.getByRole('table', { name: en.workbench.tabs.toApprove })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('draws the ceiling line with the read’s own numbers when the set was cut', async () => {
    await renderTab({ items: [row(1), row(2), row(3)], total: 7, truncated: true });

    expect(screen.getByRole('note').textContent).toBe(
      'Showing the first 3 of 7. Approvals lists every one.',
    );
  });

  it('an empty set still mounts the list, handing it the tab’s empty state', async () => {
    listAwaitingMe.mockResolvedValue({ items: [], total: 0, truncated: false });
    const { ApprovalsTab } = await import('@/app/(authed)/workbench/_components/ApprovalsTab');
    const tree = (await ApprovalsTab({ ctx: CTX })) as ReactElement<{
      rows: unknown[];
      empty: ReactElement;
    }>;

    // The LIST is what renders (MOTIR-5245), with no rows and the empty state in hand…
    expect(tree.props.rows).toEqual([]);
    // …and that empty state is a server component: resolve it as the server would.
    const empty = tree.props.empty;
    render((await (empty.type as () => Promise<ReactElement>)()) as ReactElement);
    expect(screen.getByText(en.workbench.empty.approvals.title)).toBeTruthy();
  });
});
