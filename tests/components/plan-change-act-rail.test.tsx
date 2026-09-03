// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';

// THE ACT RAIL (Story MOTIR-4054 · MOTIR-4069) — the run narrated as a RECORD,
// drawn by `design/ai-chat/plan-change-run-live.mock.html` sheet 3: three
// columns (glyph · mono act label · the line), appended in order, never
// collapsed, the newest line live while the run streams. The hook's half — what
// goes INTO `acts` — is `use-plan-change-conversation-edges.test.tsx`; this file
// hands the rail a state and asserts what it draws.

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
  decided: null,
  jobId: 'job-1',
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
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

function renderRail(state: PlanChangeConversationState, onStop?: () => void) {
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(state.review)}
      targets={[]}
      {...(onStop ? { onStop } : {})}
      {...handlers}
    />,
  );
}

function rows(): HTMLLIElement[] {
  return Array.from(screen.getByTestId('plan-change-acts').querySelectorAll('li'));
}

const RETRIEVAL: PlanChangeProgress = { kind: 'retrieval', family: 'plan_tree', blocked: false };

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

describe('PlanChangeRail — the act rail is a RECORD, not a replacing line', () => {
  it('draws one row per act, in the order narrated, and two identical lookups stay two rows', () => {
    renderRail(stateWith([{ kind: 'submitted' }, RETRIEVAL, RETRIEVAL]));

    const list = rows();
    expect(list).toHaveLength(3);
    expect(list[0]!.textContent).toMatch(/submit/i);
    expect(list[0]!.textContent).toContain('Sending the conversation to Motir AI…');
    // ⚠️ Never de-duplicated: a rail that folds these into "2 lookups" has
    // turned a record into a summary.
    expect(list[1]!.textContent).toContain('Read the plan tree');
    expect(list[2]!.textContent).toContain('Read the plan tree');
    // The three columns: glyph · mono label · line.
    expect(list[1]!.querySelector('svg')).not.toBeNull();
    expect(list[1]!.querySelector('.font-mono')?.textContent).toBe('retrieval');
  });

  it('keeps the shipped polite live region, so the newest act is announced', () => {
    renderRail(stateWith([RETRIEVAL]));
    const region = screen.getByTestId('plan-change-progress');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.contains(screen.getByTestId('plan-change-acts'))).toBe(true);
  });

  it('the LIVE line is the last one while streaming — full ink and the spinner; the rest are past', () => {
    renderRail(
      stateWith([{ kind: 'submitted' }, RETRIEVAL, { kind: 'laying', target: 'MOTIR-1' }]),
    );

    const list = rows();
    expect(list[2]!.classList.contains('text-(--el-text)')).toBe(true);
    // The shipped Spinner keeps its `role="status"`; it takes the glyph slot.
    expect(list[2]!.querySelector('[role="status"]')).not.toBeNull();
    expect(list[2]!.querySelector('svg')).toBeNull();
    // Past lines: secondary ink, and the glyph — not the spinner — in the slot.
    for (const past of [list[0]!, list[1]!]) {
      expect(past.classList.contains('text-(--el-text-secondary)')).toBe(true);
      expect(past.querySelector('[role="status"]')).toBeNull();
      expect(past.querySelector('svg')).not.toBeNull();
    }
  });

  it('the record SURVIVES the run — settled, nothing is live and nothing is dropped', () => {
    renderRail(stateWith([{ kind: 'submitted' }, RETRIEVAL], { phase: 'review', progress: null }));
    const list = rows();
    expect(list).toHaveLength(2);
    for (const row of list) expect(row.classList.contains('text-(--el-text)')).toBe(false);
  });
});

describe('PlanChangeRail — the lines (sheet 3’s table)', () => {
  it('`retrieval` names the FAMILY in words, and a family it does not know by its raw name', () => {
    renderRail(
      stateWith([
        { kind: 'retrieval', family: 'code_graph', blocked: false },
        { kind: 'retrieval', family: 'lessons', blocked: false },
        { kind: 'retrieval', family: 'brand_new_family', blocked: false },
        { kind: 'retrieval', family: null, blocked: false },
      ]),
    );
    const list = rows();
    expect(list[0]!.textContent).toContain('Read the code graph');
    expect(list[1]!.textContent).toContain('Read the lessons');
    // Raw rather than a hole, and never the string "undefined".
    expect(list[2]!.textContent).toContain('Read the brand_new_family');
    expect(list[3]!.textContent).toContain("Read from the plan's sources");
    expect(screen.getByTestId('plan-change-acts').textContent).not.toContain('undefined');
  });

  it('a BLOCKED lookup is a different sentence with its own glyph, not a suffix', () => {
    renderRail(
      stateWith([RETRIEVAL, { kind: 'retrieval', family: 'plan_tree', blocked: true }], {
        phase: 'review',
        progress: null,
      }),
    );
    const [open, blocked] = rows();
    expect(blocked!.textContent).toContain('Out of lookups — carrying on with what it has.');
    expect(blocked!.textContent).not.toContain('Read the');
    // The `ban` glyph (lucide draws it as a circle + a diagonal line) versus the
    // open book: the two rows must not share a glyph, because the moment the run
    // stopped being able to read is what a skim should catch.
    expect(open!.querySelector('svg')?.innerHTML).not.toBe(
      blocked!.querySelector('svg')?.innerHTML,
    );
  });

  it('the planner’s OWN prose line renders verbatim', () => {
    renderRail(stateWith([{ kind: 'note', text: 'the billing epic already owns this' }]));
    const [row] = rows();
    expect(row!.textContent).toContain('the billing epic already owns this');
    expect(row!.querySelector('.font-mono')?.textContent).toBe('note');
  });

  it('a frame nobody has decided about is a DRAWN line naming the raw kind — loud, not an error', () => {
    renderRail(stateWith([{ kind: 'unknown', frame: 'some_future_frame' }]));
    const [row] = rows();
    expect(row!.textContent).toContain('frame: some_future_frame');
    // Not the error affordance: no alert role, no rose tint.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(row!.className).not.toContain('tint-rose');
  });

  it('laying and authoring name what is being laid and written; the six shipped lines are unchanged', () => {
    renderRail(
      stateWith([
        { kind: 'laying', target: 'MOTIR-42' },
        { kind: 'authoring', title: 'Monthly schedule' },
        { kind: 'searching' },
        { kind: 'drilling' },
        { kind: 'proposed', count: 2 },
        { kind: 'validating' },
      ]),
    );
    const text = rows().map((r) => r.textContent ?? '');
    expect(text[0]).toContain('Laying out MOTIR-42');
    expect(text[1]).toContain('Writing Monthly schedule');
    expect(text[2]).toContain('Reading your plan…');
    expect(text[3]).toContain('Working through the tree…');
    expect(text[4]).toContain('2 items proposed so far…');
    expect(text[5]).toContain('Checking the proposal against your plan…');
  });
});

describe('PlanChangeRail — the running bar repeats the live act’s OWN line', () => {
  it('a note in the bar is the planner’s words; a lookup names its family', () => {
    const onStop = vi.fn();
    renderRail(stateWith([RETRIEVAL, { kind: 'note', text: 'billing already owns this' }]), onStop);
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      'billing already owns this',
    );

    cleanup();
    renderRail(stateWith([{ kind: 'retrieval', family: 'web', blocked: false }]), onStop);
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain('Read the web');
  });
});

describe('PlanChangeRail — the transcript FOLLOWS the newest act (sheet 5)', () => {
  // Nine act lines fit at the 1366×768 floor after the ordinary opening, and a
  // real run emits several times that, so the transcript WILL scroll. Following
  // the newest act is what keeps the record readable; NOT following once the
  // reader has scrolled up is what makes leaving them alone safe.
  function tall(log: HTMLElement, scrollHeight: number) {
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 300 });
  }

  it('scrolls to the bottom as acts arrive while the reader is at the bottom', () => {
    const view = renderRail(stateWith([{ kind: 'submitted' }]));
    const log = screen.getByRole('log');
    tall(log, 1000);

    view.rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="PayFlow"
        state={stateWith([{ kind: 'submitted' }, RETRIEVAL])}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );
    expect(log.scrollTop).toBe(1000);
  });

  it('leaves a reader who scrolled UP where they are — the pinned bar carries the live line instead', () => {
    const view = renderRail(stateWith([{ kind: 'submitted' }]));
    const log = screen.getByRole('log');
    tall(log, 1000);
    // The reader scrolls up to re-read an earlier act…
    log.scrollTop = 100;
    fireEvent.scroll(log);

    view.rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="PayFlow"
        state={stateWith([{ kind: 'submitted' }, RETRIEVAL])}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );
    // …and the next act does not yank them back down.
    expect(log.scrollTop).toBe(100);
  });
});

describe('PlanChangeRail — the record sits ABOVE the surviving proposal (sheet 2, state D)', () => {
  it('acts, then the stopped marker, then the review block', () => {
    renderRail(
      stateWith([{ kind: 'submitted' }, RETRIEVAL], {
        phase: 'review',
        progress: null,
        stopped: true,
        review: planReview([
          planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
        ]),
      }),
    );
    const acts = screen.getByTestId('plan-change-acts');
    const stopped = screen.getByTestId('plan-change-stopped');
    const review = screen.getByTestId('plan-change-review');
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(acts, stopped)).toBe(true);
    expect(follows(stopped, review)).toBe(true);
  });
});
