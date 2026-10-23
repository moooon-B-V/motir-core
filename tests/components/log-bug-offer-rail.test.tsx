// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type {
  LogBugOfferTargetDto,
  PlanAnswerOfferDto,
  PlanChangeSessionDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';
import type { AuthoredBug } from '@/lib/ai/authoredBug';
import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// No jest-dom (project convention): assertions read the DOM directly.
// THE LOG-A-BUG OFFER in the rail (Story MOTIR-9220 · MOTIR-9324). The plan offer's
// row, naming the ONE write a yes makes; Confirm and Decline are the plan offer's
// handlers; what it wrote is the debug outcome line in the answer bubble. The rail is
// presentational, so each state is asserted by handing it the thread core served.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const en = enMessages.planningWorkspace.logBugOffer;

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'] = 'user',
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'Mentions vanish when I save' : 'Saving strips the mention.',
    jobId: 'job-1',
    question: null,
    confirm: null,
    isAnswer: role === 'assistant',
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra,
  };
}

type Target = LogBugOfferTargetDto;
const NEW: Target = { kind: 'new', key: null, title: null };
const ANCHORED: Target = { kind: 'anchored', key: 'ACME-7', title: 'Mention disappears' };
const EXISTING: Target = { kind: 'existing', key: 'ACME-40', title: 'Comment save path' };

function offer(target: Target, extra: Partial<PlanAnswerOfferDto> = {}): PlanAnswerOfferDto {
  return {
    kind: 'log_bug',
    requestMd: 'Saving a comment drops the @mention',
    targetKey: target.key,
    bug: {
      title: 'Saving a comment drops the @mention',
      acceptanceCriteria: ['A saved comment keeps its @mention'],
      draft: {} as AuthoredBug,
      target,
      targetUpdatedAt: null,
      contextRefs: ['lib/comments/save.ts'],
    },
    declinedAt: null,
    declinedById: null,
    confirmedAt: null,
    confirmedById: null,
    confirmedSessionId: null,
    state: 'undecided',
    cannotStart: null,
    ...extra,
  };
}

const REFS: Record<string, WorkItemRefSummaryDto> = {
  'ACME-40': {
    accessible: true,
    id: 'wi-40',
    identifier: 'ACME-40',
    title: 'Comment save path',
    kind: 'task',
    archived: false,
    status: null,
    type: null,
    assignee: null,
  },
};

function session(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-22T10:00:00.000Z',
    origin: 'conversation',
    startedByViewer: true,
    createdAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    turns,
    workItemRefs: REFS,
  };
}

function offered(o: PlanAnswerOfferDto, extra: Partial<PlanChangeTurnDto> = {}) {
  return session([turn(0), turn(1, 'assistant', { offer: o, ...extra })]);
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: offered(offer(NEW)),
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
  acts: [],
};

const onConfirmPlanOffer = vi.fn();
const onDeclinePlanOffer = vi.fn();

function rail(
  state: Partial<PlanChangeConversationState> = {},
  opts: { answering?: string | null; refusal?: { turnId: string; code: string } | null } = {},
) {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onStop={vi.fn()}
      onConfirmPlanOffer={onConfirmPlanOffer}
      onDeclinePlanOffer={onDeclinePlanOffer}
      offerAnsweringTurnId={opts.answering ?? null}
      offerRefusal={opts.refusal ?? null}
    />
  );
}

const renderRail = (...args: Parameters<typeof rail>) => renderWithIntl(rail(...args));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const write = () => screen.getByTestId('log-bug-offer-write');

describe('a pending offer names its one write before agreement', () => {
  it.each([
    ['new', NEW, en.writeNew],
    ['anchored', ANCHORED, 'Add the diagnosis to ACME-7'],
    ['existing', EXISTING, 'Note the diagnosis on'],
  ])('%s', (kind, target, text) => {
    renderRail({ session: offered(offer(target)) });
    const row = screen.getByTestId('plan-offer');
    expect(row.getAttribute('data-offer-kind')).toBe('log_bug');
    expect(row.getAttribute('aria-label')).toBe(en.label);
    expect(write().getAttribute('data-target')).toBe(kind);
    expect(write().textContent).toContain(text);
    expect(screen.getByTestId('plan-offer-request').textContent).toContain(
      'Saving a comment drops the @mention',
    );
    // No plan-offer target line or mid-planning copy on a bug offer.
    expect(screen.queryByTestId('plan-offer-no-target')).toBeNull();
    expect(row.textContent).toContain(en.confirmHelp);
  });

  it('names the covering work item by key and title', () => {
    renderRail({ session: offered(offer(EXISTING)) });
    expect(write().textContent).toContain('ACME-40');
    expect(write().textContent).toContain('Comment save path');
  });
});

describe('Confirm and Decline are the plan offer’s handlers', () => {
  it('fires each once with the offer’s turn id', () => {
    renderRail({ session: offered(offer(NEW)) });
    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    fireEvent.click(screen.getByTestId('plan-offer-decline'));
    expect(onConfirmPlanOffer).toHaveBeenCalledTimes(1);
    expect(onConfirmPlanOffer).toHaveBeenCalledWith('t1');
    expect(onDeclinePlanOffer).toHaveBeenCalledWith('t1');
  });

  it('disables both while a confirm is in flight, with the logging label', () => {
    renderRail({ session: offered(offer(ANCHORED)) }, { answering: 't1' });
    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    const confirm = screen.getByTestId('plan-offer-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect((screen.getByTestId('plan-offer-decline') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a confirmed offer', () => {
  it('draws no buttons and the outcome line linking the card it wrote — from the turn itself', () => {
    renderRail({
      session: offered(
        offer(EXISTING, { state: 'confirmed', confirmedAt: '2026-10-22T10:05:00Z' }),
        {
          debugLanding: {
            outcome: 'enrich_existing',
            workItemKey: 'ACME-40',
            title: 'Comment save path',
            createdInTriage: false,
          },
        },
      ),
    });
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('plan-offer-decline')).toBeNull();
    expect(screen.getByTestId('plan-offer-confirmed').textContent).toContain(en.logged);
    const line = screen.getByTestId('plan-change-debug-outcome');
    expect(line.getAttribute('data-outcome')).toBe('enrich_existing');
    expect(within(line).getByText('ACME-40')).toBeTruthy();
  });

  it('a new bug’s outcome line says it was filed, not in Triage', () => {
    renderRail({
      session: offered(offer(NEW, { state: 'confirmed' }), {
        debugLanding: {
          outcome: 'diagnose',
          workItemKey: 'ACME-41',
          title: 'Saving a comment drops the @mention',
          createdInTriage: false,
        },
      }),
    });
    const line = screen.getByTestId('plan-change-debug-outcome');
    expect(line.textContent).toContain('ACME-41');
    expect(line.textContent).not.toContain('Triage');
  });
});

describe('a declined or replaced offer draws no buttons', () => {
  it.each([
    ['declined', { state: 'declined' as const, declinedAt: '2026-10-22T10:05:00Z' }],
    ['superseded', { state: 'superseded' as const }],
  ])('%s', (_label, extra) => {
    renderRail({ session: offered(offer(ANCHORED, extra)) });
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('plan-offer-decline')).toBeNull();
  });

  it('a declined offer says nothing was written', () => {
    renderRail({ session: offered(offer(NEW, { state: 'declined' })) });
    expect(screen.getByTestId('plan-offer-declined').textContent).toContain(en.recorded);
  });
});

describe('a refused confirm shows its reason in place of the buttons', () => {
  it.each([
    ['DEBUG_TARGET_CHANGED', EXISTING, en.cannotStart.targetChanged.replace('{key}', 'ACME-40')],
    ['NOT_FOUND', EXISTING, en.cannotStart.targetUnavailable.replace('{key}', 'ACME-40')],
    [
      'DEBUG_ANCHOR_NOT_TRIAGE_BUG',
      ANCHORED,
      en.cannotStart.anchorNotTriage.replace('{key}', 'ACME-7'),
    ],
    ['PERMISSION_DENIED', NEW, en.cannotStart.planningUnavailable],
    ['offer_not_open', NEW, en.cannotStart.generic],
  ])('%s', (code, target, text) => {
    renderRail({ session: offered(offer(target)) }, { refusal: { turnId: 't1', code } });
    const line = screen.getByTestId('plan-offer-cannot-start');
    expect(line.getAttribute('data-reason')).toBe(code);
    expect(line.textContent).toBe(text);
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
  });

  it('a served cannotStart draws the bug offer’s line, not the planning one', () => {
    renderRail({ session: offered(offer(NEW, { cannotStart: 'planning_unavailable' })) });
    expect(screen.getByTestId('plan-offer-cannot-start').textContent).toBe(
      en.cannotStart.planningUnavailable,
    );
  });
});

describe('in Chinese', () => {
  it('draws every string from the zh catalogue', () => {
    const zh = zhMessages.planningWorkspace.logBugOffer;
    renderWithIntl(rail({ session: offered(offer(NEW)) }), { messages: zhMessages, locale: 'zh' });
    expect(screen.getByTestId('plan-offer').getAttribute('aria-label')).toBe(zh.label);
    expect(write().textContent).toBe(zh.writeNew);
    expect(screen.getByTestId('plan-offer').textContent).toContain(zh.confirmHelp);
  });
});
