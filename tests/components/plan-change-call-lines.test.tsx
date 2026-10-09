// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { CALL_TOOL_PLACEHOLDER } from '@/components/planning/planCallLines';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { TOOL_CALL_FAMILIES } from '@/lib/planning/planChangeFrames';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type {
  PlanChangeConversationState,
  PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';

// THE PER-CALL LINES ON THE RAIL (Story MOTIR-7974 · MOTIR-7979), built to
// MOTIR-7975's design: `design/ai-chat/plan-change-run-live--per-call.mock.html`
// and its `design-notes.md` section. Every expected string is formatted from the
// catalogue, never retyped.

type CallAct = Extract<PlanChangeProgress, { kind: 'call' }>;

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const NS = 'planningWorkspace.conversation';
/** The catalogue's own formatter. Keys are built from data here (a tool name),
 *  so it is typed over strings rather than the catalogue's literal key union. */
type T = (key: string, values?: Record<string, string | number>) => string;
const tEn = createTranslator({ locale: 'en', messages: en, namespace: NS }) as unknown as T;
const tZh = createTranslator({ locale: 'zh', messages: zh, namespace: NS }) as unknown as T;

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

/** A well-formed call for `tool`, with a short object so nothing is shortened. */
function callFor(tool: string): CallAct {
  const placeholder = CALL_TOOL_PLACEHOLDER[tool];
  const value =
    placeholder === 'path'
      ? 'lib/a.ts'
      : placeholder === 'item' || placeholder === 'parent'
        ? 'MOTIR-7'
        : 'billing';
  return call({
    tool,
    object:
      placeholder === null ? null : { kind: placeholder === 'path' ? 'path' : 'query', value },
  });
}

function expectedLine(t: T, act: CallAct): string {
  const placeholder = CALL_TOOL_PLACEHOLDER[act.tool!];
  if (placeholder === null || placeholder === undefined) return t(`act.call.tool.${act.tool}`);
  return t(`act.call.tool.${act.tool}`, { [placeholder]: act.object!.value });
}

const callRows = () => screen.getAllByTestId('plan-change-call');
const LAY: PlanChangeProgress = { kind: 'laying', target: 'MOTIR-1' };

function assertClean(text: string) {
  expect(text.trim().length).toBeGreaterThan(0);
  expect(text).not.toContain('undefined');
  expect(text).not.toContain('progress.call');
  expect(text).not.toMatch(/act\.(call|family)\./);
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

describe('every tool in the design’s copy table reads as its own line', () => {
  const tools = Object.keys(CALL_TOOL_PLACEHOLDER);

  it.each([
    ['en', tEn],
    ['zh', tZh],
  ] as const)('in %s, filled with its object, one row per call in arrival order', (locale, t) => {
    const calls = tools.map(callFor);
    // Settled, so the step folds — the lines are still in the DOM, behind it.
    renderRail(stateWith([LAY, ...calls], { phase: 'idle' }), { locale });
    const rows = callRows();
    expect(rows).toHaveLength(calls.length);
    rows.forEach((row, i) => {
      expect(row.textContent).toBe(expectedLine(t, calls[i]!));
      assertClean(row.textContent ?? '');
    });
  });

  it('the zh lines are the zh catalogue’s, not the en one’s', () => {
    for (const tool of tools) {
      expect(expectedLine(tZh, callFor(tool))).not.toBe(expectedLine(tEn, callFor(tool)));
    }
  });
});

describe('generic lines — never blank, never undefined, never a raw key', () => {
  it.each(['en', 'zh'] as const)('in %s', (locale) => {
    const t = locale === 'zh' ? tZh : tEn;
    const malformed = [
      call({ object: null }),
      call({ tool: 'brand_new_tool' }),
      call({ verb: null }),
      call({ tool: null, family: null, verb: null, object: null }),
      ...TOOL_CALL_FAMILIES.map((family) => call({ tool: 'unlisted', family, object: null })),
    ];
    renderRail(stateWith([LAY, ...malformed], { phase: 'idle' }), { locale });
    const rows = callRows();
    expect(rows[0]!.textContent).toBe(t('act.call.family.code_read'));
    expect(rows[1]!.textContent).toBe(t('act.call.family.code_read'));
    // An unknown verb changes the glyph, not the words.
    expect(rows[2]!.textContent).toBe(expectedLine(t, call()));
    expect(rows[3]!.textContent).toBe(t('act.call.family.none'));
    TOOL_CALL_FAMILIES.forEach((family, i) => {
      expect(rows[4 + i]!.textContent).toBe(t(`act.call.family.${family}`));
    });
    for (const row of rows) assertClean(row.textContent ?? '');
  });

  it('a code_read lookup row names its family in words, not as `code_read`', () => {
    renderRail(stateWith([{ kind: 'retrieval', family: 'code_read', blocked: false }]));
    const acts = screen.getByTestId('plan-change-acts');
    expect(acts.textContent).toContain(
      tEn('act.retrievalLine', { family: tEn('act.family.codeRead') }),
    );
    expect(acts.textContent).not.toContain('code_read');
  });
});

describe('the marks', () => {
  it('failed, refused and skipped carry their word and glyph, and none borrows the error affordance', () => {
    renderRail(
      stateWith(
        [
          LAY,
          call({ outcome: 'failed' }),
          call({
            tool: 'update_item',
            family: 'item',
            verb: 'update',
            outcome: 'refused',
            object: { kind: 'item', value: 'MOTIR-418' },
          }),
          call({ outcome: 'skipped' }),
          { kind: 'retrieval', family: 'plan_tree', blocked: true },
        ],
        { phase: 'idle' },
      ),
    );
    const [failed, refused, skipped] = callRows();
    expect(failed!.dataset['outcome']).toBe('failed');
    expect(within(failed!).getByTestId('plan-change-call-mark').textContent).toBe(
      tEn('act.call.mark.failed'),
    );
    expect(within(refused!).getByTestId('plan-change-call-mark').textContent).toBe(
      tEn('act.call.mark.refused'),
    );
    expect(within(skipped!).getByTestId('plan-change-call-mark').textContent).toBe(
      tEn('act.call.mark.skipped'),
    );
    // `x` for failed and refused; the shipped `ban` for skipped, the same glyph
    // as the shipped blocked row, which stays as it was.
    expect(failed!.querySelector('svg')?.classList.contains('lucide-x')).toBe(true);
    expect(refused!.querySelector('svg')?.classList.contains('lucide-x')).toBe(true);
    const blocked = screen.getByTestId('plan-change-act-retrieval');
    expect(blocked.textContent).toContain(tEn('act.retrievalBlockedLine'));
    expect(skipped!.querySelector('svg')?.innerHTML).toBe(blocked.querySelector('svg')?.innerHTML);
    // The mark word is the strong ink; nothing reads as a failed RUN.
    expect(within(failed!).getByTestId('plan-change-call-mark').className).toContain(
      'text-(--el-text-strong)',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const html = screen.getByTestId('plan-change-acts').innerHTML;
    expect(html).not.toContain('tint-rose');
    expect(html).not.toContain('destructive');
    expect(html).not.toContain('--el-danger');
  });

  it('a marked call is never live, even as the newest in an open step', () => {
    renderRail(stateWith([LAY, call(), call({ outcome: 'failed' })]));
    const [, newest] = callRows();
    expect(newest!.querySelector('[role="status"]')).toBeNull();
  });
});

describe('call lines nest under their step', () => {
  it('interleaved calls from two live author sessions sit under their own steps', () => {
    const a = (extra: Partial<CallAct>) =>
      call({ tool: 'get_item', family: 'plan_tree', verb: 'look_up', ...extra });
    renderRail(
      stateWith([
        { kind: 'authoring', title: 'Card A' },
        { kind: 'authoring', title: 'Card B' },
        a({ itemRef: 'Card A', object: { kind: 'item', value: 'MOTIR-1' } }),
        a({ itemRef: 'Card B', object: { kind: 'item', value: 'MOTIR-2' } }),
        a({ itemRef: 'Card A', object: { kind: 'item', value: 'MOTIR-3' } }),
        a({ itemRef: 'Unknown card', object: { kind: 'item', value: 'MOTIR-4' } }),
      ]),
    );
    const steps = screen.getAllByTestId('plan-change-act-authoring');
    const lines = (step: HTMLElement) =>
      within(step)
        .getAllByTestId('plan-change-call')
        .map((row) => row.textContent);
    expect(steps[0]!.textContent).toContain('Card A');
    expect(lines(steps[0]!)).toEqual(['Looking up MOTIR-1', 'Looking up MOTIR-3']);
    // A ref matching no live step joins the most recent step — never lost.
    expect(lines(steps[1]!)).toEqual(['Looking up MOTIR-2', 'Looking up MOTIR-4']);
    // Both sessions are open: each one's newest call carries the spinner.
    for (const step of steps) {
      const rows = within(step).getAllByTestId('plan-change-call');
      expect(rows[rows.length - 1]!.querySelector('[role="status"]')).not.toBeNull();
      expect(rows[0]!.querySelector('[role="status"]')).toBeNull();
    }
  });

  it('a call before any step is its own row', () => {
    renderRail(stateWith([call(), { kind: 'submitted' }], { phase: 'idle' }));
    const acts = screen.getByTestId('plan-change-acts');
    expect(acts.firstElementChild?.getAttribute('data-testid')).toBe('plan-change-call');
  });

  it('a finished step folds behind a disclosure carrying the count and the failures; the reader’s expansion stays', () => {
    const acts: PlanChangeProgress[] = [
      LAY,
      call(),
      call({ outcome: 'failed' }),
      call(),
      { kind: 'authoring', title: 'Card A' },
    ];
    const view = renderRail(stateWith(acts));
    const toggle = screen.getByTestId('plan-change-calls-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe(tEn('act.call.countFailed', { count: 3, failed: 1 }));
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(list.hidden).toBe(true);
    // Folded is presentation only: every call is in the record.
    expect(within(list).getAllByTestId('plan-change-call')).toHaveLength(3);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);

    // A new act arrives — nothing auto-folds the group the reader opened.
    view.rerender(rail(stateWith([...acts, call({ itemRef: 'Card A' })])));
    expect(screen.getByTestId('plan-change-calls-toggle').getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('a step with no calls is the shipped row, with no disclosure', () => {
    renderRail(stateWith([LAY, { kind: 'validating' }], { phase: 'idle' }));
    expect(screen.queryByTestId('plan-change-calls-toggle')).toBeNull();
    expect(screen.queryByTestId('plan-change-calls')).toBeNull();
  });

  it('an open step shows its newest two; the rest sit behind an earlier-calls row', () => {
    const calls = [call(), call(), call(), call()];
    renderRail(stateWith([LAY, ...calls]));
    const step = screen.getByTestId('plan-change-act-laying');
    expect(step.dataset['step']).toBe('open');
    expect(within(step).getAllByTestId('plan-change-call')).toHaveLength(2);
    const earlier = within(step).getByTestId('plan-change-calls-earlier');
    expect(earlier.textContent).toBe(tEn('act.call.earlier', { count: 2 }));
    fireEvent.click(earlier);
    expect(within(step).getAllByTestId('plan-change-call')).toHaveLength(4);
    expect(earlier.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('truncation, with the full value reachable', () => {
  const LONG_PATH = 'packages/design-system/src/components/theme/StyleVignette.tsx';
  const LONG_QUERY = 'sessions that outlive a password change everywhere';

  it.each(['en', 'zh'] as const)(
    'in %s, the short form is drawn and the full value is a keyboard stop and in the accessible name',
    (locale) => {
      const t = locale === 'zh' ? tZh : tEn;
      renderRail(
        stateWith(
          [
            LAY,
            call({ object: { kind: 'path', value: LONG_PATH } }),
            call({
              tool: 'search_work_items',
              family: 'plan_tree',
              verb: 'search',
              object: { kind: 'query', value: LONG_QUERY },
            }),
          ],
          { phase: 'idle' },
        ),
        { locale },
      );
      const [path, query] = screen.getAllByTestId('plan-change-call-object');
      expect(path!.tabIndex).toBe(0);
      expect(path!.querySelector('[aria-hidden="true"]')?.textContent).toBe(
        'packages/…/StyleVignette.tsx',
      );
      expect(path!.querySelector('.sr-only')?.textContent).toBe(
        t('act.call.full.path', { value: LONG_PATH }),
      );
      expect(query!.querySelector('[aria-hidden="true"]')?.textContent).toBe(
        'sessions that outlive a passwor…',
      );
      expect(query!.querySelector('.sr-only')?.textContent).toBe(
        t('act.call.full.query', { value: LONG_QUERY }),
      );
      // Not a hover-only `title`.
      expect(path!.getAttribute('title')).toBeNull();
    },
  );

  it('an object within the cap is plain text, with nothing to reach', () => {
    renderRail(stateWith([LAY, call()], { phase: 'idle' }));
    expect(screen.queryByTestId('plan-change-call-object')).toBeNull();
  });
});

describe('the running bar and the one live region', () => {
  it('one open step: the bar repeats its newest call', () => {
    renderRail(stateWith([LAY, call()]), { onStop: vi.fn() });
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      expectedLine(tEn, call()),
    );
  });

  it('parallel author sessions: `{line} · {title}`, line first', () => {
    renderRail(
      stateWith([
        { kind: 'authoring', title: 'Card A' },
        { kind: 'authoring', title: 'Card B' },
        call({ itemRef: 'Card A' }),
      ]),
      { onStop: vi.fn() },
    );
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      tEn('act.call.barParallel', { line: expectedLine(tEn, call()), title: 'Card A' }),
    );
  });

  it('the rail holds exactly one live region; it announces rows and marks, not calls', () => {
    const first = call();
    const view = renderRail(stateWith([LAY, first]));
    expect(view.container.querySelectorAll('[aria-live]')).toHaveLength(1);
    const announcer = screen.getByTestId('plan-change-announcer');
    expect(screen.getByTestId('plan-change-progress').contains(announcer)).toBe(true);
    expect(announcer.textContent).toBe(tEn('act.layingLine', { target: 'MOTIR-1' }));

    // A call appended: not announced.
    const second = call({ object: { kind: 'path', value: 'lib/b.ts' } });
    view.rerender(rail(stateWith([LAY, first, second])));
    expect(announcer.textContent).toBe(tEn('act.layingLine', { target: 'MOTIR-1' }));

    // A call marked failed: announced with its mark.
    view.rerender(rail(stateWith([LAY, { ...first, outcome: 'failed' }, second])));
    expect(announcer.textContent).toBe(
      tEn('act.call.announceFailed', { line: expectedLine(tEn, first) }),
    );

    // A step appended: announced.
    view.rerender(
      rail(stateWith([LAY, { ...first, outcome: 'failed' }, second, { kind: 'validating' }])),
    );
    expect(announcer.textContent).toBe(tEn('progress.validating', { count: 0 }));
  });
});
