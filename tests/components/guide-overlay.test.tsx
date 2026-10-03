// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { GuideTodoCanvas, GUIDE_MOTION_MS } from '@/components/planning/GuideTodoCanvas';
import { GuideRail } from '@/components/planning/GuideRail';
import { deriveGuideView, type GuideView } from '@/lib/planning/guideView';
import type { GuideAction, GuideActionOutcome, GuideTurnRecord } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// The overlay's guide mode, as its two panes draw it (Story MOTIR-7459 ·
// MOTIR-7466; design MOTIR-7462, `design/ai-chat/guide-mode.mock.html`). Both
// panes are presentational over one derived view, so each case hands them that
// view directly — the conversation hook is the host's.

let seq = 0;
function turn(
  role: PlanChangeTurnDto['role'],
  guide: GuideTurnRecord | null = null,
  body = role === 'user' ? 'go on' : 'Do step one.',
): PlanChangeTurnDto {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role,
    body,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'guide',
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-03T10:00:00.000Z',
    guide,
  };
}

function record(
  pairs: Array<[GuideAction, GuideActionOutcome['outcome']]>,
  temporary = false,
): GuideTurnRecord {
  return {
    actions: pairs.map(([a]) => a),
    outcomes: pairs.map(([a, outcome]) => ({ type: a.type, outcome })),
    temporary,
  };
}

function todo(id: string, text: string, done = false): WorkItemTodoDto {
  return {
    id,
    text,
    notesMd: null,
    commandText: null,
    executor: null,
    position: id,
    done,
    doneAt: null,
    doneBy: null,
  } as WorkItemTodoDto;
}

const step = (id: string, text: string) => ({
  id,
  text,
  notesMd: null,
  commandText: null,
  executor: null,
});

const PROPOSAL = record([
  [
    { type: 'propose_todos', rows: [step('p1', 'Open settings'), step('p2', 'Paste key')] },
    'recorded',
  ],
]);

function session(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p',
    targetKeys: ['MOTIR-9'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-03T10:00:00.000Z',
    origin: 'guide',
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    turns,
    workItemRefs: {},
  } as PlanChangeSessionDto;
}

const CARD = { id: 'w9', identifier: 'MOTIR-9', title: 'Rotate the key', kind: 'task' as const };

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  seq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
  setReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ROWS = [todo('r1', 'Open settings'), todo('r2', 'Paste key'), todo('r3', 'Save')];
const saved = (rows = ROWS, turns: PlanChangeTurnDto[] = [turn('assistant')]): GuideView =>
  deriveGuideView(turns, rows, { idle: true });

describe('GuideTodoCanvas', () => {
  it('draws a skeleton until the card rows are read', () => {
    renderWithIntl(
      <GuideTodoCanvas
        view={deriveGuideView([], null, { idle: true })}
        canTick
        onSetDone={() => {}}
      />,
    );
    expect(screen.getByTestId('guide-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('guide-row')).toBeNull();
  });

  it('draws a proposed list under its band, with nothing to tick', () => {
    renderWithIntl(
      <GuideTodoCanvas
        view={deriveGuideView([turn('assistant', PROPOSAL)], [], { idle: true })}
        canTick
        onSetDone={() => {}}
      />,
    );
    expect(screen.getByTestId('guide-proposed-band').textContent).toContain('Proposed, not saved.');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Open settings')).toBeTruthy();
  });

  it('draws a temporary walk with static boxes, Not saved tags and a Save button', () => {
    const onSave = vi.fn();
    const view = deriveGuideView(
      [
        turn('assistant', PROPOSAL),
        turn('user'),
        turn('assistant', record([[{ type: 'tick', rowId: 'p1' }, 'recorded']], true)),
      ],
      [],
      { idle: true },
    );
    renderWithIntl(<GuideTodoCanvas view={view} canTick onSetDone={() => {}} onSave={onSave} />);
    const band = screen.getByTestId('guide-temporary-band');
    expect(band.textContent).toContain('Not saved to the card.');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getAllByTestId('guide-checkbox-static')).toHaveLength(2);
    expect(screen.getAllByTestId('guide-tag-notSaved')).toHaveLength(2);
    fireEvent.click(within(band).getByRole('button', { name: 'Save to the card' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('marks the current step and shows the progress', () => {
    renderWithIntl(<GuideTodoCanvas view={saved()} canTick onSetDone={() => {}} />);
    const rows = screen.getAllByTestId('guide-row');
    expect(rows[0]!.getAttribute('data-current')).toBe('true');
    expect(rows[1]!.getAttribute('data-current')).toBeNull();
    expect(screen.getByTestId('guide-tag-current')).toBeTruthy();
    expect(screen.getByTestId('guide-progress').textContent).toContain('Step 1 of 3');
  });

  it('ticks a saved row through onSetDone', () => {
    const onSetDone = vi.fn();
    renderWithIntl(<GuideTodoCanvas view={saved()} canTick onSetDone={onSetDone} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect(onSetDone).toHaveBeenCalledWith('r2', true);
  });

  it('plays the tick on the paint that shows it, then clears it', () => {
    vi.useFakeTimers();
    const { rerender } = renderWithIntl(
      <GuideTodoCanvas view={saved()} canTick onSetDone={() => {}} />,
    );
    const ticked = [todo('r1', 'Open settings', true), ROWS[1]!, ROWS[2]!];
    rerender(<GuideTodoCanvas view={saved(ticked)} canTick onSetDone={() => {}} />);
    const row = screen.getAllByTestId('guide-row')[0]!;
    expect(row.className).toContain('guide-row--ticked');
    expect(screen.getAllByTestId('guide-row')[1]!.getAttribute('data-current')).toBe('true');
    expect(screen.getByTestId('guide-bar-fill').className).toContain('guide-bar-fill--gain');
    act(() => {
      vi.advanceTimersByTime(GUIDE_MOTION_MS);
    });
    expect(screen.getAllByTestId('guide-row')[0]!.className).not.toContain('guide-row--ticked');
  });

  it('draws the END state in one paint under reduced motion', () => {
    setReducedMotion(true);
    const { rerender } = renderWithIntl(
      <GuideTodoCanvas view={saved()} canTick onSetDone={() => {}} />,
    );
    const ticked = [todo('r1', 'Open settings', true), ROWS[1]!, ROWS[2]!];
    rerender(<GuideTodoCanvas view={saved(ticked)} canTick onSetDone={() => {}} />);
    const row = screen.getAllByTestId('guide-row')[0]!;
    expect(row.getAttribute('data-todo-done')).toBe('true');
    expect(row.getAttribute('data-motion')).toBeNull();
    expect(screen.getByTestId('guide-bar-fill').className).not.toContain('guide-bar-fill--gain');
  });

  it('says so when every step is done, and shows a refused tick', () => {
    const all = ROWS.map((r) => ({ ...r, done: true }));
    renderWithIntl(
      <GuideTodoCanvas
        view={saved(all)}
        canTick
        onSetDone={() => {}}
        tickError="That step could not be ticked."
      />,
    );
    expect(screen.getByTestId('guide-all-done')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('That step could not be ticked.');
  });
});

function renderRail(
  turns: PlanChangeTurnDto[],
  opts: {
    rows?: WorkItemTodoDto[] | null;
    phase?: 'opening' | 'idle' | 'running';
    errorCode?: string | null;
    outOfCredits?: boolean;
  } = {},
) {
  const handlers = { onSend: vi.fn(), onRetry: vi.fn(), onReload: vi.fn() };
  const phase = opts.phase ?? 'idle';
  const view = deriveGuideView(turns, opts.rows === undefined ? ROWS : opts.rows, {
    idle: phase === 'idle',
  });
  renderWithIntl(
    <GuideRail
      card={CARD}
      session={session(turns)}
      view={view}
      phase={phase}
      errorCode={opts.errorCode ?? null}
      outOfCredits={opts.outOfCredits ?? false}
      markers={[]}
      {...handlers}
    />,
  );
  return handlers;
}

describe('GuideRail', () => {
  it('names the card it was opened from, and the guide mode', () => {
    renderRail([turn('assistant')]);
    expect(screen.getByTestId('guide-opened').textContent).toContain('Opened from MOTIR-9');
    expect(screen.getByTestId('planning-mode-chip')).toBeTruthy();
  });

  it('sends the fixed words of a reply button', () => {
    const { onSend } = renderRail([turn('assistant', PROPOSAL)], { rows: [] });
    fireEvent.click(screen.getByTestId('guide-reply-walk'));
    expect(onSend).toHaveBeenCalledWith('Walk it without saving.');
    fireEvent.click(screen.getByTestId('guide-reply-save'));
    expect(onSend).toHaveBeenCalledWith('Save this list to the card.');
  });

  it('Reload the card reads the card and sends nothing', () => {
    const { onSend, onReload } = renderRail([
      turn(
        'assistant',
        record([
          [{ type: 'edit_item', reason: 'r', title: 'T', previous: { title: 'Old' } }, 'skipped'],
        ]),
      ),
    ]);
    expect(screen.getByTestId('guide-stale')).toBeTruthy();
    fireEvent.click(screen.getByTestId('guide-reply-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('draws an outcome line from what landed, naming the card', () => {
    renderRail([turn('assistant', record([[{ type: 'tick', rowId: 'r2' }, 'landed']]))]);
    const line = screen.getByTestId('guide-outcome');
    expect(line.getAttribute('data-outcome')).toBe('ticked');
    expect(line.textContent).toContain('Ticked step 2 on');
    expect(line.textContent).toContain('MOTIR-9');
  });

  it('hides the replies while a turn runs and shows the reading line', () => {
    renderRail([turn('assistant', PROPOSAL), turn('user')], { rows: [], phase: 'running' });
    expect(screen.queryByTestId('guide-replies')).toBeNull();
    expect(screen.getByTestId('guide-progress-line').textContent).toContain(
      'Reading MOTIR-9 and its to-do list',
    );
  });

  it('offers Try again on a failed turn, and not on a typed refusal', () => {
    const { onRetry } = renderRail([turn('assistant')], { errorCode: 'GUIDE_FAILED' });
    expect(screen.getByTestId('guide-error').textContent).toContain("That turn didn't finish");
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    renderRail([turn('assistant')], { errorCode: 'GUIDE_CARD_NOT_MANUAL' });
    expect(screen.getByTestId('guide-error').textContent).toContain('this card is for an agent');
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});
