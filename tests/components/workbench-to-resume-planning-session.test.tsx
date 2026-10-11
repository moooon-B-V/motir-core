// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zh from '@/messages/zh.json';
import en from '@/messages/en.json';
import type { HomeWorkItemRowDto, ToResumePlanningSessionDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';

// THE FAILED PLANNING SESSION'S TO RESUME ENTRY (Story MOTIR-7905 · MOTIR-7917; design
// `design/workbench/design-notes.md` § 37.2). The entry and its four states, its two actions,
// and the tab's composition: sessions first, then gated runs, ONE pager, ONE empty state.

const { push, refresh, shallowPush, resumePlanSession } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  shallowPush: vi.fn(),
  resumePlanSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=to-resume'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('@/lib/planning/planChangeClient', () => ({ resumePlanSession }));
vi.mock('@/lib/planning/planReviewClient', () => ({ fetchPlanReview: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { WorkbenchList } = await import('@/app/(authed)/workbench/_components/WorkbenchList');
const { toWorkbenchRowViews } = await import('@/app/(authed)/workbench/_components/workbenchRows');
const { PlanEditsClientError } = await import('@/lib/planning/planEditsClient');

const WORKFLOW = {
  statuses: [{ key: 'in_progress', label: 'In Progress', category: 'in_progress' }],
} as unknown as WorkflowDto;

const AGO = new Date(Date.now() - 5 * 60_000).toISOString();
const t = en.workbench.planningSession;

function session(over: Partial<ToResumePlanningSessionDto> = {}): ToResumePlanningSessionDto {
  return {
    sessionId: 'sess-1',
    form: 'failed_walk',
    planId: 'plan-1',
    title: null,
    waitingPlan: null,
    projectName: 'Acme',
    targets: [{ key: 'ACME-14', title: 'Export a report' }],
    failure: {
      failedAt: AGO,
      reason: 'rate_limited',
      stopPhase: 'author',
      stopRef: 'ACME-20',
      stopTitle: 'Export a report',
    },
    endedAt: null,
    progress: {
      startedAt: AGO,
      lastActivityAt: AGO,
      observedAt: AGO,
      authored: 7,
      proposed: 12,
      steps: [],
    },
    ...over,
  };
}

function run(identifier: string): HomeWorkItemRowDto {
  return {
    id: `wi_${identifier}`,
    kind: 'story',
    type: null,
    key: 1,
    identifier,
    title: `Title of ${identifier}`,
    status: 'in_progress',
    ciState: null,
    fixReason: null,
    fixDetail: null,
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-10-07T00:00:00.000Z',
    completedAt: null,
    project: { id: 'p1', identifier: 'ACME', name: 'Acme' },
    viewerIsAssignee: true,
    viewerIsReporter: false,
    canContinueHosted: false,
    fixGroupKind: null,
    fixMembers: [],
    resumeState: 'waiting_on_gate',
    resumeRunId: 'run_1',
    resumeMembers: [],
    canFixHosted: false,
    repairRun: null,
    groupHead: null,
    groupMembers: [],
  } as HomeWorkItemRowDto;
}

function mount(
  sessions: ToResumePlanningSessionDto[],
  runs: HomeWorkItemRowDto[] = [],
  opts: { locale?: 'en' | 'zh'; total?: number } = {},
) {
  const locale = opts.locale ?? 'en';
  const el = (s: ToResumePlanningSessionDto[], r: HomeWorkItemRowDto[]) => (
    <WorkbenchList
      rows={toWorkbenchRowViews(r, WORKFLOW, [], false)}
      planningSessions={s}
      label="To resume"
      tab="to-resume"
      pagination={{ total: opts.total ?? s.length + r.length, page: 1, pageSize: 25 }}
      empty={<p>Nothing to resume</p>}
      viewerId="u1"
    />
  );
  const view = renderWithIntl(el(sessions, runs), {
    locale,
    messages: locale === 'zh' ? zh : en,
  });
  return {
    ...view,
    reread: (s: ToResumePlanningSessionDto[], r: HomeWorkItemRowDto[] = runs) =>
      view.rerender(el(s, r)),
  };
}

const entryOf = (id = 'sess-1') => screen.getByTestId(`to-resume-session-${id}`);

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  resumePlanSession.mockReset();
});
afterEach(cleanup);

describe('the entry — what it shows', () => {
  it('names the plan (§ 29), where it stopped, why in words, when, and how far', () => {
    mount([session()]);
    const row = entryOf();
    expect(within(row).getByText('Plan for')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Export a report' })).toBeTruthy();
    expect(within(row).getByText('ACME-14')).toBeTruthy();
    expect(within(row).getByText(t.waitingToResume)).toBeTruthy();
    expect(within(row).getByText('Writing Export a report')).toBeTruthy();
    expect(within(row).getByText('because the model was rate-limited')).toBeTruthy();
    expect(within(row).getByText('7 of 12 written')).toBeTruthy();
    expect(within(row).getByText(/^failed /)).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(within(row).getByText('Open')).toBeTruthy();
  });

  it('the title’s quick-view door does not open the overlay', () => {
    mount([session()]);
    fireEvent.click(within(entryOf()).getByRole('link', { name: 'Export a report' }));
    expect(shallowPush).not.toHaveBeenCalledWith(expect.stringContaining('planSession'));
  });

  it('omits *N of M written* when progress is null', () => {
    mount([session({ progress: null })]);
    expect(within(entryOf()).queryByText(/written/)).toBeNull();
  });

  it('a stop with no title reads as the project’s top level; a stop with no phase as a new item', () => {
    mount([
      session({
        sessionId: 'a',
        failure: {
          failedAt: AGO,
          reason: 'internal',
          stopPhase: 'lay',
          stopRef: null,
          stopTitle: null,
        },
      }),
      session({
        sessionId: 'b',
        failure: {
          failedAt: AGO,
          reason: 'nonsense',
          stopPhase: null,
          stopRef: null,
          stopTitle: null,
        },
      }),
    ]);
    expect(within(entryOf('a')).getByText("Laying the project's top level")).toBeTruthy();
    expect(within(entryOf('b')).getByText('Drafting a new item')).toBeTruthy();
    // an unknown code reads as `internal`, never raw
    expect(within(entryOf('b')).getByText(`because ${t.reason.internal}`)).toBeTruthy();
    expect(screen.queryByText(/nonsense/)).toBeNull();
  });

  it('Open is the plan-overlay door with `planVia=resume`, and fetches nothing', () => {
    mount([session()]);
    const open = within(entryOf()).getByTestId('to-resume-session-open');
    const url = new URL(open.getAttribute('href')!, 'http://x');
    expect(url.searchParams.get('planSession')).toBe('sess-1');
    expect(url.searchParams.get('planVia')).toBe('resume');
    expect(fireEvent.click(open)).toBe(false);
    expect(shallowPush).toHaveBeenCalledTimes(1);
  });

  it('another form (a failure beside a waiting plan) has Open and NO Resume', () => {
    mount([session({ form: 'failed_beside_waiting_plan', progress: null })]);
    expect(within(entryOf()).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(within(entryOf()).getByText('Open')).toBeTruthy();
  });
});

describe('pressing Resume', () => {
  it('calls resumePlanSession ONCE and holds the entry as resuming', async () => {
    let finish!: (v: unknown) => void;
    resumePlanSession.mockReturnValue(new Promise((r) => (finish = r)));
    mount([session()]);
    const button = within(entryOf()).getByRole('button', { name: 'Resume' });
    fireEvent.click(button);
    fireEvent.click(button); // a second press while one is in flight sends nothing
    expect(resumePlanSession).toHaveBeenCalledTimes(1);
    expect(resumePlanSession).toHaveBeenCalledWith('sess-1');
    await act(async () => finish({ jobId: 'j', planId: 'plan-1', session: {} }));
    expect(entryOf().getAttribute('data-state')).toBe('resuming');
    expect(screen.getByText(t.resumingNote)).toBeTruthy();
    expect(
      within(entryOf()).getByRole('button', { name: t.resuming }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('RESUME_ALREADY_STARTED reads as resuming, not an error', async () => {
    resumePlanSession.mockRejectedValue(
      new PlanEditsClientError(409, 'RESUME_ALREADY_STARTED', { jobId: 'j' }),
    );
    mount([session()]);
    await act(async () =>
      fireEvent.click(within(entryOf()).getByRole('button', { name: 'Resume' })),
    );
    expect(entryOf().getAttribute('data-state')).toBe('resuming');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['NOT_SESSION_OWNER', 403, 'notOwner'],
    ['PLAN_NOT_RESUMABLE', 409, 'notResumable'],
    ['MOTIR_AI_OUT_OF_CREDITS', 402, 'credits'],
  ] as const)('%s keeps the row and shows its sentence', async (code, status, key) => {
    resumePlanSession.mockRejectedValue(new PlanEditsClientError(status, code));
    mount([session()]);
    await act(async () =>
      fireEvent.click(within(entryOf()).getByRole('button', { name: 'Resume' })),
    );
    expect(within(entryOf()).getByRole('alert').textContent).toContain(t.refusal[key]);
    expect(within(entryOf()).getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['PLAN_SESSION_ENDED', 'ended'],
    ['SESSION_NOT_FAILED', 'notFailed'],
  ] as const)(
    '%s holds the row with its sentence and asks the list to re-read',
    async (code, key) => {
      resumePlanSession.mockRejectedValue(new PlanEditsClientError(409, code));
      mount([session()]);
      await act(async () =>
        fireEvent.click(within(entryOf()).getByRole('button', { name: 'Resume' })),
      );
      expect(within(entryOf()).getByRole('alert').textContent).toContain(t.refusal[key]);
      expect(within(entryOf()).queryByRole('button', { name: 'Resume' })).toBeNull();
      expect(refresh).toHaveBeenCalled();
    },
  );
});

describe('a re-read', () => {
  it('a newer `failedAt` carries the *Second attempt* note and the NEW reason', async () => {
    resumePlanSession.mockResolvedValue({ jobId: 'j', planId: 'plan-1', session: {} });
    const view = mount([session()]);
    await act(async () =>
      fireEvent.click(within(entryOf()).getByRole('button', { name: 'Resume' })),
    );
    expect(entryOf().getAttribute('data-state')).toBe('resuming');

    const later = new Date(Date.parse(AGO) + 60_000).toISOString();
    view.reread([
      session({
        failure: {
          failedAt: later,
          reason: 'model_unavailable',
          stopPhase: 'lay',
          stopRef: null,
          stopTitle: 'Export a report',
        },
      }),
    ]);
    expect(entryOf().getAttribute('data-state')).toBe('failed-again');
    expect(within(entryOf()).getByText(t.second)).toBeTruthy();
    expect(within(entryOf()).getByText('Laying Export a report')).toBeTruthy();
    expect(within(entryOf()).getByText(`because ${t.reason.model_unavailable}`)).toBeTruthy();
    expect(within(entryOf()).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('an entry the read drops is HELD in place until the next load', () => {
    const view = mount([session()]);
    view.reread([]);
    expect(entryOf().getAttribute('data-held')).toBe('true');
  });
});

describe('the tab’s composition — sessions first, one pager, one empty state', () => {
  it('two sessions then two runs, in read order, with the pager over total 4', () => {
    mount(
      [session({ sessionId: 's1' }), session({ sessionId: 's2' })],
      [run('ACME-31'), run('ACME-32')],
    );
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-testid'));
    const ids = rows.map((r) => r.getAttribute('data-testid'));
    expect(ids.slice(0, 2)).toEqual(['to-resume-session-s1', 'to-resume-session-s2']);
    expect(ids.slice(2).every((id) => id?.startsWith('to-resume-session-') === false)).toBe(true);
    expect(screen.getByText('Title of ACME-31')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy(); // the pager's denominator counts both
  });

  it('both empty → the empty state once; only sessions → no empty state', () => {
    const { unmount } = mount([], []);
    expect(screen.getAllByText('Nothing to resume')).toHaveLength(1);
    unmount();
    mount([session()], []);
    expect(screen.queryByText('Nothing to resume')).toBeNull();
    expect(entryOf()).toBeTruthy();
  });
});

describe('zh', () => {
  it('renders the entry in Chinese, with no English leaking in', () => {
    mount([session()], [], { locale: 'zh' });
    const row = entryOf();
    expect(within(row).getByText(zh.workbench.planningSession.waitingToResume)).toBeTruthy();
    expect(within(row).getByText('正在撰写「Export a report」')).toBeTruthy();
    expect(within(row).getByText('已写 7/12')).toBeTruthy();
    expect(within(row).getByRole('button', { name: '继续' })).toBeTruthy();
    expect(row.textContent).not.toMatch(/Resume|Open|written|because/);
    expect(zh.workbench.tabs.toApprove).not.toContain('待审批');
  });
});
