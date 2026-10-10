// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { HomeWorkItemRowDto, ToResumePlanningSessionDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';

// TO RESUME, SITUATION 2 (Story MOTIR-7905 · MOTIR-7940; design `design/workbench/design-notes.md`
// § 38, mock `workbench--to-resume--situation-2.mock.html`): a failure beside a waiting plan (B)
// and a session that ended `failed` before this story (C) — Open only, calm tone — and the
// failed walk (A) with a waiting plan named beside it.

const { push, refresh, shallowPush, resumePlanSession, fetchPlanReview } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  shallowPush: vi.fn(),
  resumePlanSession: vi.fn(),
  fetchPlanReview: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=to-resume'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('@/lib/planning/planChangeClient', () => ({ resumePlanSession }));
vi.mock('@/lib/planning/planReviewClient', () => ({ fetchPlanReview }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { WorkbenchList } = await import('@/app/(authed)/workbench/_components/WorkbenchList');
const { toWorkbenchRowViews } = await import('@/app/(authed)/workbench/_components/workbenchRows');

const WORKFLOW = {
  statuses: [{ key: 'in_progress', label: 'In Progress', category: 'in_progress' }],
} as unknown as WorkflowDto;
const AGO = new Date(Date.now() - 5 * 60_000).toISOString();
const DAYS_AGO = new Date(Date.now() - 3 * 86_400_000).toISOString();
const t = en.workbench.planningSession;

const FAILURE = {
  failedAt: AGO,
  reason: 'rate_limited',
  stopPhase: null,
  stopRef: null,
  stopTitle: null,
} as const;

function base(over: Partial<ToResumePlanningSessionDto>): ToResumePlanningSessionDto {
  return {
    sessionId: 'sess-1',
    form: 'failed_beside_waiting_plan',
    planId: 'plan-w',
    title: null,
    waitingPlan: { planId: 'plan-w', title: 'Import contacts', status: 'planned' },
    projectName: 'Acme',
    targets: [{ key: 'ACME-14', title: 'Export a report' }],
    failure: FAILURE,
    endedAt: null,
    progress: null,
    ...over,
  };
}
const formB = (over: Partial<ToResumePlanningSessionDto> = {}) => base(over);
const formC = (over: Partial<ToResumePlanningSessionDto> = {}) =>
  base({ form: 'ended_with_waiting_plan', failure: null, endedAt: DAYS_AGO, ...over });
const formA = (over: Partial<ToResumePlanningSessionDto> = {}) =>
  base({
    form: 'failed_walk',
    planId: 'plan-g',
    failure: { ...FAILURE, stopPhase: 'author', stopTitle: 'Export a report' },
    progress: {
      startedAt: AGO,
      lastActivityAt: AGO,
      observedAt: AGO,
      authored: 7,
      proposed: 12,
      steps: [],
    },
    ...over,
  });

function gatedRun(): HomeWorkItemRowDto {
  return {
    id: 'wi_ACME-31',
    kind: 'story',
    type: null,
    key: 31,
    identifier: 'ACME-31',
    title: 'Theme tokens for exports',
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
  } as HomeWorkItemRowDto;
}

function mount(
  sessions: ToResumePlanningSessionDto[],
  runs: HomeWorkItemRowDto[] = [],
  locale: 'en' | 'zh' = 'en',
) {
  const el = (s: ToResumePlanningSessionDto[]) => (
    <WorkbenchList
      rows={toWorkbenchRowViews(runs, WORKFLOW, [], false)}
      planningSessions={s}
      label="To resume"
      tab="to-resume"
      pagination={{ total: s.length + runs.length, page: 1, pageSize: 25 }}
      empty={<p>Nothing to resume</p>}
      viewerId="u1"
    />
  );
  const view = renderWithIntl(el(sessions), { locale, messages: locale === 'zh' ? zh : en });
  return { ...view, reread: (s: ToResumePlanningSessionDto[]) => view.rerender(el(s)) };
}
const entryOf = (id = 'sess-1') => screen.getByTestId(`to-resume-session-${id}`);

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  resumePlanSession.mockReset();
  fetchPlanReview.mockReset();
});
afterEach(cleanup);

describe('form B — a failure beside a waiting plan', () => {
  it('names the plan, its state, the failed change, the reason, when — and offers Open only', () => {
    mount([formB()]);
    const row = entryOf();
    expect(within(row).getByText('Plan for')).toBeTruthy();
    expect(within(row).getByText(t.form.b.stateWaiting)).toBeTruthy();
    expect(within(row).getByText(t.form.b.badChange)).toBeTruthy();
    expect(within(row).getByText('because the model was rate-limited')).toBeTruthy();
    expect(within(row).getByText(/^failed /)).toBeTruthy();
    expect(within(row).getByText(t.form.b.nextReply)).toBeTruthy();
    expect(within(row).getByText('Open')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(within(row).queryByText(/written/)).toBeNull();
  });

  it('a STALE waiting plan reads *Out of date* and says to plan it again', () => {
    mount([formB({ waitingPlan: { planId: 'plan-w', title: null, status: 'stale' } })]);
    expect(within(entryOf()).getByText(t.form.b.stateStale)).toBeTruthy();
    expect(within(entryOf()).getByText(t.form.b.nextAgain)).toBeTruthy();
    expect(within(entryOf()).queryByText(t.form.b.nextReply)).toBeNull();
  });
});

describe('form C — a session that ended `failed` before this story', () => {
  it('names the plan and its state, that the conversation ended, the carry gloss — Open only, no failure', () => {
    mount([formC()]);
    const row = entryOf();
    expect(within(row).getByText(t.form.c.chip)).toBeTruthy();
    expect(within(row).getByText(t.form.b.stateWaiting)).toBeTruthy();
    expect(within(row).getByText(/^The conversation ended /)).toBeTruthy();
    expect(within(row).getByText(t.form.c.gloss)).toBeTruthy();
    expect(within(row).getByText('Open')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(within(row).queryByText(/because|written|failed/)).toBeNull();
  });
});

describe('tone — calm on every form, never danger or warning', () => {
  it.each([
    ['B', formB()],
    ['C', formC()],
    ['A', formA()],
  ])('form %s carries no danger / warning class', (_label, entry) => {
    mount([entry]);
    expect(entryOf().outerHTML).not.toMatch(/danger|warning|destructive/);
  });

  it('form A and B wear the awaiting pill; C a neutral chip', () => {
    mount([formA({ sessionId: 'a' }), formB({ sessionId: 'b' }), formC({ sessionId: 'c' })]);
    expect(within(entryOf('a')).getByText(t.waitingToResume).className).toContain('tint-yellow');
    expect(within(entryOf('b')).getByText(t.waitingToResume).className).toContain('tint-yellow');
    expect(within(entryOf('c')).getByText(t.form.c.chip).className).not.toContain('tint-yellow');
  });
});

describe('form A with a waiting plan beside it', () => {
  it('stays the failed-walk entry (Resume + Open) and names the waiting plan on a second line', () => {
    mount([formA()]);
    const row = entryOf();
    expect(within(row).getByText('Writing Export a report')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Resume' })).toBeTruthy();
    const also = within(row).getByTestId('to-resume-also-waiting');
    expect(also.textContent).toContain(t.form.walk.alsoWaiting);
    expect(within(also).getByText('Import contacts')).toBeTruthy();
  });

  it('with no waiting plan there is no second line', () => {
    mount([formA({ waitingPlan: null })]);
    expect(within(entryOf()).queryByTestId('to-resume-also-waiting')).toBeNull();
  });
});

describe('Open — the one plan-overlay door, for every form', () => {
  it.each([
    ['B', formB()],
    ['C', formC()],
  ])(
    'form %s: a plain click opens in place; a modified click keeps the href; no fetch',
    (_l, entry) => {
      mount([entry]);
      const open = within(entryOf()).getByTestId('to-resume-session-open');
      const url = new URL(open.getAttribute('href')!, 'http://x');
      expect(url.searchParams.get('planSession')).toBe('sess-1');
      expect(url.searchParams.get('planVia')).toBe('resume');
      expect(fireEvent.click(open, { metaKey: true })).toBe(true);
      expect(shallowPush).not.toHaveBeenCalled();
      expect(fireEvent.click(open)).toBe(false);
      expect(shallowPush).toHaveBeenCalledTimes(1);
      expect(fetchPlanReview).not.toHaveBeenCalled();
    },
  );
});

describe('the mixed list, and an entry that LEAVES', () => {
  it('A, B, C and a gated run render in read order under one pager of 4', () => {
    mount(
      [formA({ sessionId: 'a' }), formB({ sessionId: 'b' }), formC({ sessionId: 'c' })],
      [gatedRun()],
    );
    const ids = screen
      .getAllByRole('row')
      .map((r) => r.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && id.startsWith('to-resume-session-'));
    expect(ids).toEqual(['to-resume-session-a', 'to-resume-session-b', 'to-resume-session-c']);
    expect(screen.getByText('Theme tokens for exports')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('a dropped B entry is HELD with *revised in the same conversation*, never *resuming*', async () => {
    fetchPlanReview.mockResolvedValue({ status: 'planned' });
    const view = mount([formB()]);
    view.reread([]);
    expect(entryOf().getAttribute('data-held')).toBe('true');
    expect(await screen.findByText(t.left.turn)).toBeTruthy();
    expect(within(entryOf()).queryByText(t.resuming)).toBeNull();
  });

  it('a dropped C entry reads *carried into a new conversation*', async () => {
    fetchPlanReview.mockResolvedValue({ status: 'planned' });
    const view = mount([formC()]);
    view.reread([]);
    expect(await screen.findByText(t.left.carry)).toBeTruthy();
  });

  it('a plan that was DECIDED reads *decided*, and a stale B reads *planning it again*', async () => {
    fetchPlanReview.mockResolvedValue({ status: 'approved' });
    const view = mount([formB()]);
    view.reread([]);
    expect(await screen.findByText(t.left.decided)).toBeTruthy();
    cleanup();

    fetchPlanReview.mockResolvedValue({ status: 'stale' });
    const again = mount([
      formB({ waitingPlan: { planId: 'plan-w', title: null, status: 'stale' } }),
    ]);
    again.reread([]);
    expect(await screen.findByText(t.left.again)).toBeTruthy();
  });
});

describe('zh', () => {
  it('renders B and C in Chinese with no English leaking in', () => {
    mount([formB({ sessionId: 'b' }), formC({ sessionId: 'c' })], [], 'zh');
    const b = entryOf('b');
    expect(within(b).getByText(zh.workbench.planningSession.form.b.badChange)).toBeTruthy();
    expect(within(b).getByText(zh.workbench.planningSession.form.b.stateWaiting)).toBeTruthy();
    expect(within(b).getByText('打开')).toBeTruthy();
    expect(b.textContent).not.toMatch(/Open|Reply|failed|Waiting/);
    const c = entryOf('c');
    expect(within(c).getByText(zh.workbench.planningSession.form.c.chip)).toBeTruthy();
    expect(within(c).getByText(zh.workbench.planningSession.form.c.gloss)).toBeTruthy();
    expect(c.textContent).not.toMatch(/ended|Open|carries/);
  });
});
