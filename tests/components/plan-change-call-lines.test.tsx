// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';

// THE PER-CALL LINES ARE GONE FROM THE RAIL (Story MOTIR-8060 · MOTIR-8064).
// This file used to pin MOTIR-7979's per-call lines; MOTIR-8061's design delta
// (`design/ai-chat/design-notes.md` § "⭐ Planner narration in the chat panel")
// retires them for both planners, so it now pins their ABSENCE: whatever call acts
// the stream recorded — every outcome, before or under a step, hosted or plan.py —
// the rail draws no call line, no call-count disclosure and no earlier-calls row,
// the running bar never repeats a call, and the one live region never speaks one.
// Step rows still render. Every expected string is formatted from the catalogue.

type CallAct = Extract<PlanChangeProgress, { kind: 'call' }>;

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const NS = 'planningWorkspace.conversation';
/** The catalogue's own formatter. Keys are built from data here (a tool name),
 *  so it is typed over strings rather than the catalogue's literal key union. */
type T = (key: string, values?: Record<string, string | number>) => string;
const tEn = createTranslator({ locale: 'en', messages: en, namespace: NS }) as unknown as T;

const SESSION: PlanChangeSessionDto = {
  id: 's1',
  projectId: 'p1',
  targetKeys: [],
  turnCount: 0,
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-07-27T09:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
};

const BASE: PlanChangeConversationState = {
  phase: 'streaming',
  session: SESSION,
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

function stateWith(
  acts: PlanChangeProgress[],
  extra: Partial<PlanChangeConversationState> = {},
): PlanChangeConversationState {
  return { ...BASE, acts, progress: acts[acts.length - 1] ?? null, ...extra };
}

function rail(state: PlanChangeConversationState, onStop?: () => void) {
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(state.review)}
      targets={[]}
      {...(onStop ? { onStop } : {})}
      {...handlers}
    />
  );
}

function renderRail(
  state: PlanChangeConversationState,
  { locale = 'en', onStop }: { locale?: 'en' | 'zh'; onStop?: () => void } = {},
) {
  return renderWithIntl(rail(state, onStop), {
    locale,
    messages: locale === 'zh' ? zh : en,
  });
}

let seq = 0;
function call(extra: Partial<CallAct> = {}): CallAct {
  seq += 1;
  return {
    kind: 'call',
    callId: `c${seq}`,
    tool: 'read_file',
    family: 'code_read',
    verb: 'read',
    object: { kind: 'path', value: 'lib/auth/passwords.ts' },
    itemRef: null,
    outcome: 'running',
    ...extra,
  };
}

const LAY: PlanChangeProgress = { kind: 'laying', target: 'MOTIR-1' };

/** Tools across the families the design's retired copy table covered. */
const TOOLS = ['read_file', 'search_work_items', 'code_callers', 'web_search', 'author', 'lay'];

function expectNoCallChrome(container: HTMLElement) {
  for (const id of [
    'plan-change-call',
    'plan-change-calls',
    'plan-change-calls-toggle',
    'plan-change-calls-earlier',
    'plan-change-call-mark',
    'plan-change-call-object',
  ]) {
    expect(container.querySelectorAll(`[data-testid="${id}"]`)).toHaveLength(0);
  }
  expect(container.textContent ?? '').not.toContain('lib/auth/passwords.ts');
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

const OUTCOMES: CallAct['outcome'][] = ['running', 'failed', 'refused', 'skipped'];

describe('no call line renders, for any call act', () => {
  it('every tool and every outcome, under a step and before one', () => {
    const acts: PlanChangeProgress[] = [
      call(),
      LAY,
      ...TOOLS.flatMap((tool) => OUTCOMES.map((outcome) => call({ tool, outcome }))),
    ];
    const view = renderRail(stateWith(acts));
    expectNoCallChrome(view.container);
    // The step row still renders, as the shipped three-column row.
    const step = screen.getByTestId('plan-change-act-laying');
    expect(step.textContent).toContain(tEn('act.layingLine', { target: 'MOTIR-1' }));
    expect(screen.getAllByTestId(/^plan-change-act-/)).toHaveLength(1);
  });

  it('parallel author sessions keep their step rows and draw none of their calls', () => {
    renderRail(
      stateWith([
        { kind: 'authoring', title: 'Card A' },
        { kind: 'authoring', title: 'Card B' },
        call({ itemRef: 'Card A' }),
        call({ itemRef: 'Card B', outcome: 'failed' }),
      ]),
    );
    expectNoCallChrome(document.body);
    expect(screen.getAllByTestId('plan-change-act-authoring')).toHaveLength(2);
  });

  it('a record of nothing but calls draws no record at all', () => {
    const view = renderRail(stateWith([call(), call({ outcome: 'failed' })]));
    expectNoCallChrome(view.container);
    expect(screen.queryByTestId('plan-change-acts')).toBeNull();
  });

  it('a run that has ended draws none either, in zh', () => {
    const view = renderRail(stateWith([LAY, call()], { phase: 'idle', jobId: null }), {
      locale: 'zh',
    });
    expectNoCallChrome(view.container);
  });
});

describe('the running bar and the one live region', () => {
  it('the bar repeats the newest step, never a call', () => {
    renderRail(stateWith([LAY, call()]), { onStop: vi.fn() });
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      tEn('act.layingLine', { target: 'MOTIR-1' }),
    );
  });

  it('the rail holds exactly one live region; it announces rows, never a call or its mark', () => {
    const first = call();
    const view = renderRail(stateWith([LAY, first]));
    expect(view.container.querySelectorAll('[aria-live]')).toHaveLength(1);
    const announcer = screen.getByTestId('plan-change-announcer');
    const said = tEn('act.layingLine', { target: 'MOTIR-1' });
    expect(announcer.textContent).toBe(said);

    const second = call({ object: { kind: 'path', value: 'lib/b.ts' } });
    view.rerender(rail(stateWith([LAY, first, second])));
    expect(announcer.textContent).toBe(said);

    view.rerender(rail(stateWith([LAY, { ...first, outcome: 'failed' }, second])));
    expect(announcer.textContent).toBe(said);

    view.rerender(
      rail(stateWith([LAY, { ...first, outcome: 'failed' }, second, { kind: 'validating' }])),
    );
    expect(announcer.textContent).toBe(tEn('progress.validating', { count: 0 }));
  });
});
