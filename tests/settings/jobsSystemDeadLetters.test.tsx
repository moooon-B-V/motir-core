// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { JobRunDlqDTO, JobRunDTO, SystemDlqListDTO } from '@/lib/dto/jobs';

// MOTIR-8083 — the System tab's dead letters with NO workspace, and their Replay
// control, built to `design/jobs/system-dead-letters.mock.html` (MOTIR-8084).
//
// What is asserted is the DESIGN's decisions, not the markup: two sections with
// the dead letters FIRST, the status filter and the pager moved INTO the runs
// section, the summary line, Replay absent on a replayed row (the deliberate
// deviation from the workspace tab), each outcome's toast, the empty state, and
// that the workspace Dead letter tab is exactly what it was.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/workspace/jobs',
}));

const toast = vi.fn();
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }));

const replayDlqAction = vi.fn();
const replaySystemDlqAction = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/jobs/actions', () => ({
  replayDlqAction: (...a: unknown[]) => replayDlqAction(...a),
  replaySystemDlqAction: (...a: unknown[]) => replaySystemDlqAction(...a),
}));

import { JobsDashboard } from '@/app/(authed)/settings/workspace/jobs/_components/JobsDashboard';

const WORKSPACE_ROUTE = '/settings/workspace/jobs';
const ORG_ROUTE = '/settings/organization';

function dlq(over: Partial<JobRunDlqDTO> & { id: string }): JobRunDlqDTO {
  return {
    workspaceId: null,
    functionId: 'system.platform-meter-report',
    eventName: 'system.platform-meter-report',
    eventData: { containerId: 'c-1' },
    failure: { name: 'Error', message: 'MOTIR_AI_UNAVAILABLE', stack: null } as never,
    attempts: 5,
    firstFailedAt: '2026-10-02T14:00:00.000Z',
    lastFailedAt: '2026-10-02T14:05:00.000Z',
    replayedAt: null,
    ...over,
  };
}

function run(id: string): JobRunDTO {
  return {
    id,
    workspaceId: null,
    functionId: 'system.ci-runner-reap',
    eventName: 'scheduled.system',
    eventId: `evt-${id}`,
    lane: 'engine',
    attempt: 1,
    status: 'succeeded',
    startedAt: '2026-10-10T07:00:00.000Z',
    finishedAt: '2026-10-10T07:00:02.000Z',
    durationMs: 2000,
    failure: null,
    output: null,
    idempotencyKey: null,
    delivery: null,
  };
}

const WAITING_A = dlq({ id: 'dlq-a' });
const WAITING_B = dlq({ id: 'dlq-b', lastFailedAt: '2026-10-02T14:10:00.000Z' });
const REPLAYED = dlq({
  id: 'dlq-r',
  functionId: 'system.ci-runner-reap',
  eventName: 'scheduled.system',
  attempts: 1,
  replayedAt: '2026-10-08T09:40:00.000Z',
});

const LIST: SystemDlqListDTO = {
  rows: [WAITING_A, WAITING_B, REPLAYED],
  waiting: 2,
  replayedRecently: 1,
};

function renderSystem(
  over: Partial<Parameters<typeof JobsDashboard>[0]> = {},
  options?: Parameters<typeof renderWithIntl>[1],
) {
  return renderWithIntl(
    <JobsDashboard
      activeTab="system"
      page={1}
      hasNext={false}
      dlqCount={3}
      isOwner={false}
      showSystemTab
      runs={[run('r1')]}
      dlq={[]}
      systemDlq={LIST}
      {...over}
    />,
    options,
  );
}

const dlqSection = () => document.querySelector('section[aria-labelledby="system-dlq-heading"]')!;
const runsSection = () => document.querySelector('section[aria-labelledby="system-runs-heading"]')!;

beforeEach(() => {
  replaySystemDlqAction.mockResolvedValue({ ok: true });
  replayDlqAction.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Panel 1 — the System tab is two sections, dead letters FIRST', () => {
  it('draws "Dead letters with no workspace" above "System runs"', () => {
    renderSystem();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Dead letters with no workspace', 'System runs']);
    expect(
      dlqSection().compareDocumentPosition(runsSection()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('states both counts under the title', () => {
    renderSystem();
    expect(
      within(dlqSection() as HTMLElement).getByText(
        '2 waiting to be replayed · 1 replayed in the last 7 days',
      ),
    ).toBeTruthy();
  });

  it('keeps the shipped seven columns, with View on every row', () => {
    renderSystem();
    const table = within(dlqSection() as HTMLElement).getByRole('table', {
      name: 'System dead letters',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual([
      'Function',
      'Event',
      'Attempts',
      'First failed',
      'Last failed',
      'Replayed',
      'Actions',
    ]);
    expect(within(table).getAllByRole('button', { name: 'View' })).toHaveLength(3);
  });

  it('moves the status filter INTO the runs section — the dead letters have none', () => {
    renderSystem();
    const filter = screen.getByRole('group', { name: /filter/i });
    expect(runsSection().contains(filter)).toBe(true);
    expect(dlqSection().contains(filter)).toBe(false);
    // …so the tab's top row keeps only Refresh.
    expect(screen.getAllByRole('group', { name: /filter/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('moves the pager INTO the runs section — the dead letters have none', () => {
    renderSystem({ page: 2, hasNext: true });
    const next = screen.getByRole('link', { name: 'Next' });
    expect(runsSection().contains(next)).toBe(true);
    expect(next.getAttribute('href')).toBe(`${WORKSPACE_ROUTE}?tab=system&page=3`);
    // No link of any kind lives in the dead-letter section: no filter, no pager.
    expect(dlqSection().querySelectorAll('a')).toHaveLength(0);
  });

  it('draws the runs table unchanged beneath it', () => {
    renderSystem();
    expect(
      within(runsSection() as HTMLElement).getByRole('table', { name: 'Background job runs' }),
    ).toBeTruthy();
  });

  it('says so in words when there are no system runs, and keeps the dead letters above', () => {
    renderSystem({ runs: [] });
    expect(within(runsSection() as HTMLElement).getByText('No job runs yet')).toBeTruthy();
    expect(dlqSection().querySelectorAll('tbody tr')).toHaveLength(3);
  });
});

describe('Panels 2 and 4b — the Replay control is present on a waiting row and ABSENT on a replayed one', () => {
  it('one Replay button per unreplayed row, none on the replayed row', () => {
    renderSystem();
    const rows = within(dlqSection() as HTMLElement)
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole('button', { name: 'Replay' })).toBeTruthy();
    expect(within(rows[1]!).getByRole('button', { name: 'Replay' })).toBeTruthy();
    expect(within(rows[2]!).queryByRole('button', { name: 'Replay' })).toBeNull();
    // The replayed row keeps its stamp and its View.
    expect(within(rows[2]!).getByText('Oct 8, 09:40 AM UTC')).toBeTruthy();
    expect(within(rows[2]!).getByRole('button', { name: 'View' })).toBeTruthy();
  });

  it('the control is never disabled and never wrapped in the owner-only tooltip — only the operator sees this tab', () => {
    renderSystem({ isOwner: false });
    for (const btn of screen.getAllByRole('button', { name: 'Replay' })) {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('a replayed row steps its ink down to secondary', () => {
    renderSystem();
    const row = within(dlqSection() as HTMLElement).getAllByRole('row')[3]!;
    expect(within(row).getByText('system.ci-runner-reap').className).toContain(
      'text-(--el-text-secondary)',
    );
  });
});

describe('Panels 2 and 3 — pressing Replay', () => {
  const press = async (rowIndex = 0) => {
    const btn = within(dlqSection() as HTMLElement).getAllByRole('button', { name: 'Replay' })[
      rowIndex
    ]!;
    await act(async () => {
      fireEvent.click(btn);
    });
  };

  it('calls the OPERATOR action with that row — never the workspace one', async () => {
    renderSystem();
    await press(1);
    await waitFor(() => expect(replaySystemDlqAction).toHaveBeenCalledWith('dlq-b'));
    expect(replayDlqAction).not.toHaveBeenCalled();
  });

  it('replayed → a success toast, then a refresh', async () => {
    renderSystem();
    await press();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success', title: 'Job replayed' }),
      ),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('already-replayed → an info toast (a double click or a stale page), then a refresh', async () => {
    replaySystemDlqAction.mockResolvedValue({ ok: true, alreadyReplayed: true });
    renderSystem();
    await press();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'info', title: 'Already replayed' }),
      ),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('a workspace row → an error toast carrying the door to use, and the row is left as it was', async () => {
    replaySystemDlqAction.mockResolvedValue({
      ok: false,
      error:
        "That dead letter belongs to a workspace — replay it from that workspace's Dead letter tab.",
    });
    renderSystem();
    await press();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        variant: 'error',
        title: 'Could not replay',
        description:
          "That dead letter belongs to a workspace — replay it from that workspace's Dead letter tab.",
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Replay' })).toHaveLength(2);
  });

  it('gone → an error toast', async () => {
    replaySystemDlqAction.mockResolvedValue({
      ok: false,
      error: 'That dead-letter entry no longer exists.',
    });
    renderSystem();
    await press();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'error',
          description: 'That dead-letter entry no longer exists.',
        }),
      ),
    );
  });

  it('replaying → ONLY that row’s button shows busy and disabled', async () => {
    let finish!: (v: { ok: boolean }) => void;
    replaySystemDlqAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderSystem();
    await press(0);

    const buttons = within(dlqSection() as HTMLElement).getAllByRole('button', { name: 'Replay' });
    await waitFor(() => expect((buttons[0] as HTMLButtonElement).disabled).toBe(true));
    expect(buttons[0]!.getAttribute('aria-busy')).toBe('true');
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
    expect(buttons[1]!.getAttribute('aria-busy')).not.toBe('true');

    await act(async () => {
      finish({ ok: true });
    });
    await waitFor(() => expect(toast).toHaveBeenCalled());
  });
});

describe('Panel 5a — the empty state', () => {
  it('replaces the table with its own words; the runs section is unaffected', () => {
    renderSystem({ systemDlq: { rows: [], waiting: 0, replayedRecently: 0 } });
    const section = dlqSection() as HTMLElement;
    expect(within(section).getByText('No system dead letters')).toBeTruthy();
    expect(
      within(section).getByText(
        'Every job without a workspace has succeeded or is still retrying.',
      ),
    ).toBeTruthy();
    expect(within(section).queryByRole('table')).toBeNull();
    // The summary still states the (zero) counts under the same heading.
    expect(
      within(section).getByText('0 waiting to be replayed · 0 replayed in the last 7 days'),
    ).toBeTruthy();
    expect(within(runsSection() as HTMLElement).getByRole('table')).toBeTruthy();
  });

  it('treats a missing list the same as an empty one', () => {
    renderSystem({ systemDlq: null });
    expect(within(dlqSection() as HTMLElement).getByText('No system dead letters')).toBeTruthy();
  });
});

describe('Panel 6 — both doors draw the same section, linked to the host that renders it', () => {
  it.each([WORKSPACE_ROUTE, ORG_ROUTE])('mounted at %s, every link comes home', (base) => {
    const { container } = renderSystem({ basePath: base, page: 2, hasNext: true });
    const hrefs = [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.startsWith(base), href).toBe(true);
    expect(screen.getByRole('heading', { name: 'Dead letters with no workspace' })).toBeTruthy();
  });
});

describe('Panel 4a — everyone else sees none of it', () => {
  it('the runs tab carries no dead-letter section and no System tab without showSystemTab', () => {
    renderSystem({ activeTab: 'runs', showSystemTab: false, systemDlq: null });
    expect(screen.queryByRole('link', { name: 'System' })).toBeNull();
    expect(screen.queryByText('Dead letters with no workspace')).toBeNull();
    expect(screen.queryByText('System runs')).toBeNull();
  });

  it('the runs tab keeps its status filter at the top, as before', () => {
    renderSystem({ activeTab: 'runs', showSystemTab: false, systemDlq: null });
    expect(screen.getByRole('group', { name: /filter/i })).toBeTruthy();
    expect(document.querySelector('section[aria-labelledby="system-runs-heading"]')).toBeNull();
  });
});

describe('the workspace Dead letter tab is unchanged', () => {
  const ROW = dlq({ id: 'ws-1', workspaceId: 'ws', replayedAt: '2026-10-08T09:40:00.000Z' });

  it('an owner keeps Replay on a REPLAYED row and it calls the workspace action', async () => {
    renderSystem({ activeTab: 'dlq', isOwner: true, systemDlq: null, runs: [], dlq: [ROW] });
    const btn = screen.getByRole('button', { name: 'Replay' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(replayDlqAction).toHaveBeenCalledWith('ws-1'));
    expect(replaySystemDlqAction).not.toHaveBeenCalled();
  });

  it('a non-owner still sees a disabled Replay', () => {
    renderSystem({ activeTab: 'dlq', isOwner: false, systemDlq: null, runs: [], dlq: [ROW] });
    expect((screen.getByRole('button', { name: 'Replay' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('draws the shipped table caption, not the system one', () => {
    renderSystem({ activeTab: 'dlq', isOwner: true, systemDlq: null, runs: [], dlq: [ROW] });
    expect(screen.getByRole('table', { name: 'Dead-letter queue' })).toBeTruthy();
  });
});
