// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';

// THE WORKING TURN IS ONE ROW (MOTIR-9213; `design/ai-chat/design-notes.md`
// § _The Motir mark at work_ › _Where the mark sits_,
// `planning-workspace--mark-at-work.mock.html` panels 1–3). The turn Motir AI is
// working on gathers the hand-off, the act record and the planner notes beside ONE
// avatar, which flows while Motir AI is at work; the rail header no longer carries
// a mark, and every other Motir avatar holds the still 17 px glyph.

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

const READING: PlanChangeProgress = { kind: 'reading' };

const BASE: PlanChangeConversationState = {
  phase: 'streaming',
  session: session([turn(0, 'Add recurring invoices.')]),
  progress: READING,
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
  acts: [READING],
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
  );
}

const marks = () => document.querySelectorAll<HTMLElement>('[data-testid="plan-at-work-mark"]');
const row = () => screen.queryByTestId('plan-work-row');

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

describe('the working turn is one row with one avatar', () => {
  it('a conversation turn being read: the act record sits in the row, and its avatar is at work', () => {
    renderRail(BASE);
    expect(row()).not.toBeNull();
    expect(row()!.contains(screen.getByTestId('plan-change-acts'))).toBe(true);
    expect(marks()).toHaveLength(1);
    expect(row()!.firstElementChild).toBe(marks()[0]!);
    expect(marks()[0]!.getAttribute('data-at-work')).toBe('true');
    expect(marks()[0]!.getAttribute('aria-hidden')).toBe('true');
  });

  it('the rail header carries no mark any more', () => {
    renderRail(BASE);
    const header = screen.getByTestId('planning-mode-chip').parentElement!;
    expect(header.querySelector('[data-testid="plan-at-work-mark"]')).toBeNull();
  });

  it('a plan run writing: the hand-off is the row’s first message and gives up its own avatar', () => {
    renderRail({ ...BASE, planId: 'plan-1', settledJobId: 'job-1', acts: [], progress: null });
    const handoff = screen.getByTestId('plan-handoff');
    expect(row()!.contains(handoff)).toBe(true);
    // The hand-off is a message body now, not a Bubble with a disc of its own.
    expect(handoff.querySelector('svg')).toBeNull();
    expect(handoff.parentElement!.firstElementChild).toBe(handoff);
    expect(marks()).toHaveLength(1);
    // While a plan run is in its planning phase the stream does not count: the
    // plan's own reading decides, and there is none to read here.
    expect(marks()[0]!.getAttribute('data-at-work')).toBe('false');
  });

  it('the reply landed: no row, no mark at work, and every avatar holds the still 17 px glyph', () => {
    renderRail({ ...BASE, phase: 'idle', jobId: null, acts: [], progress: null });
    expect(row()).toBeNull();
    expect(marks()).toHaveLength(0);
    const glyphs = document.querySelectorAll<SVGElement>('.brand-inv > svg.brand-glyph');
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute('width')).toBe('17');
      expect(glyph.parentElement!.parentElement!.className).toContain('overflow-hidden');
    }
  });

  it('streaming before the first act lands still draws the row, so the mark is on screen at once', () => {
    renderRail({ ...BASE, acts: [], progress: null });
    expect(row()).not.toBeNull();
    expect(marks()[0]!.getAttribute('data-at-work')).toBe('true');
  });
});
