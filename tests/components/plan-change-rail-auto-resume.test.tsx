// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview } from '../helpers/planReview';
import enMessages from '@/messages/en.json';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';

// Story MOTIR-8301 · MOTIR-8309/8310 — the rail's resume row is drawn from the LIVE review read's
// progress (`design/ai-planning/design-notes.md` Part XXVII §27.7): the rail hands
// `liveReview.progress.autoResume` to the act record, and draws nothing without it.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function turn(seq: number, body: string): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role: 'user',
    body,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: 'u1',
    createdAt: '2026-07-27T10:00:00.000Z',
  };
}

function session(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'streaming',
  session: session([turn(0, 'Add recurring invoices.')]),
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: 'job-1',
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

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onCorrectTurn: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
};

function stateWith(acts: PlanChangeProgress[], extra: Partial<PlanChangeConversationState> = {}) {
  return {
    ...BASE,
    acts,
    progress: acts.length > 0 ? acts[acts.length - 1]! : null,
    ...extra,
  };
}

function renderRail(state: PlanChangeConversationState) {
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(state.review)}
      targets={[]}
      {...handlers}
    />,
    { locale: 'en', messages: enMessages },
  );
}

const RESUMED_AT = '2026-10-12T14:00:00.000Z';

function liveReview(autoResume: { at: string; count: number } | null) {
  return planReview([], {
    status: 'generating',
    progress: {
      startedAt: '2026-10-12T13:40:00.000Z',
      lastActivityAt: RESUMED_AT,
      observedAt: RESUMED_AT,
      authored: 0,
      proposed: 1,
      steps: [],
      autoResume,
    },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PlanChangeRail — the resume row comes from the live review read', () => {
  it('opens the act record with the resume line when the plan was resumed automatically', () => {
    renderRail(
      stateWith([{ kind: 'submitted' }], { liveReview: liveReview({ at: RESUMED_AT, count: 1 }) }),
    );

    expect(screen.getByTestId('plan-change-act-resumed').textContent).toContain(
      'Lost its machine — Motir started it again and it picks up where it stopped',
    );
  });

  it('draws no resume line for a plan that was never resumed automatically', () => {
    renderRail(stateWith([{ kind: 'submitted' }], { liveReview: liveReview(null) }));

    expect(screen.queryByTestId('plan-change-act-resumed')).toBeNull();
  });
});
