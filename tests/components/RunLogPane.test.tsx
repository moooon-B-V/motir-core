// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunLogPane } from '@/app/(authed)/runs/_components/RunLogPane';
import type {
  DispatchRunCardDto,
  DispatchRunDto,
  DispatchRunEventDto,
} from '@/lib/dto/dispatchRuns';

// THE LOG PANE of the run modal (Story MOTIR-1789 · MOTIR-3962).
//
// ⚠️ THE THREE SILENCES ARE THE LOAD-BEARING PART. Sending log bodies is opt-in
// and off by default, so the ORDINARY run has nothing here — and one message for
// all three tells a person their run failed to record when in fact they chose
// that, or when the record simply aged out. Each is asserted separately, because
// collapsing them is exactly the defect that would still look correct.

afterEach(cleanup);

function leg(over: Partial<DispatchRunCardDto> = {}): DispatchRunCardDto {
  return {
    id: 'leg_1',
    key: 'MOTIR-1791',
    workItemId: 'wi_1',
    position: 0,
    disposition: 'implemented',
    skipReason: null,
    sessionBranch: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    model: null,
    ...over,
  };
}

function run(over: Partial<DispatchRunDto> = {}): DispatchRunDto {
  return {
    id: 'run_1',
    projectId: 'prj',
    command: 'run',
    origin: 'local',
    scopeWorkItemId: null,
    scopeLabel: null,
    status: 'succeeded',
    stopReason: 'drained',
    agent: 'claude',
    model: null,
    // Recent, so the default finished run is the NEVER-SENT silence rather
    // than the expired one.
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    endedAt: new Date().toISOString(),
    createdById: null,
    lastHeartbeatAt: null,
    reportedBy: 'cli',
    agentInstance: null,
    cards: [leg(), leg({ id: 'leg_2', key: 'MOTIR-1793', workItemId: 'wi_2' })],
    seq: 0,
    ...over,
  };
}

function logEvent(seq: number, body: string, workItemKey?: string): DispatchRunEventDto {
  return {
    id: `e${seq}`,
    seq,
    kind: 'log',
    cardId: 'leg_1',
    data: workItemKey === undefined ? null : { workItemKey },
    body,
    reportedBy: 'cli',
    createdAt: '2026-08-30T14:02:00.000Z',
  };
}

async function mount(
  dto: DispatchRunDto,
  selected: string | null = null,
  events: DispatchRunEventDto[] = [],
): Promise<void> {
  render(<RunLogPane run={dto} events={events} selectedWorkItemId={selected} />);
  await act(async () => {});
}

describe('⚠️ THE THREE SILENCES are distinct, and none reads as an error', () => {
  it('a finished run that sent nothing NAMES THE FLAG — it was the operator’s choice', async () => {
    await mount(run());

    const panel = screen.getByTestId('run-log-silence-neverSent');
    expect(panel.textContent).toContain('Nothing was sent');
    // Naming the flag is the whole remedy; without it the message is a dead end.
    expect(panel.textContent).toContain('--report-log');
  });

  it('a LIVE run that has printed nothing yet is WAITING, which is not empty', async () => {
    await mount(run({ status: 'running', stopReason: null, endedAt: null }));

    const panel = screen.getByTestId('run-log-silence-waiting');
    expect(panel.textContent).toContain('Waiting for the agent');
    expect(screen.queryByTestId('run-log-silence-neverSent')).toBeNull();
  });

  it('a run older than the 30-day window says the record AGED OUT, not that it failed', async () => {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await mount(run({ startedAt: old }));

    const panel = screen.getByTestId('run-log-silence-expired');
    expect(panel.textContent).toContain('Past the retention window');
    expect(panel.textContent).toContain('30 days');
    // ⚠️ It does NOT accuse the operator of a choice they may not have made.
    expect(panel.textContent).not.toContain('--report-log');
  });
});

describe('the lines — backfill and live through ONE path, in seq order', () => {
  it('renders what the stream backfills, and resumes from seq 0 to get it', async () => {
    await mount(run(), null, [logEvent(1, 'first line'), logEvent(2, 'second line')]);

    expect(screen.getByText('first line')).toBeTruthy();
    expect(screen.getByText('second line')).toBeTruthy();
  });

  it('orders by SEQ, not by arrival', async () => {
    await mount(run(), null, [logEvent(9, 'later'), logEvent(2, 'earlier')]);

    const body = screen.getByTestId('run-log-body');
    expect(body.textContent!.indexOf('earlier')).toBeLessThan(body.textContent!.indexOf('later'));
  });

  it('a REPLAYED seq is one line, not two — the reconnect contract', async () => {
    await mount(run(), null, [logEvent(1, 'only once'), logEvent(1, 'only once')]);

    expect(screen.getAllByText('only once')).toHaveLength(1);
  });

  it('ignores every event kind that is not a log', async () => {
    const other: DispatchRunEventDto = {
      id: 'e1',
      seq: 1,
      kind: 'card_settled',
      cardId: null,
      data: null,
      body: null,
      reportedBy: 'cli',
      createdAt: '2026-08-30T14:02:00.000Z',
    };
    await mount(run(), null, [other]);

    // No lines ⇒ still a silence, not an empty console.
    expect(screen.getByTestId('run-log-silence-neverSent')).toBeTruthy();
  });
});

describe('the FILTER follows the modal’s selection', () => {
  it('unfiltered, every line names its source member', async () => {
    await mount(run(), null, [
      logEvent(1, 'from a', 'MOTIR-1791'),
      logEvent(2, 'from b', 'MOTIR-1793'),
    ]);

    expect(screen.getByText('MOTIR-1791')).toBeTruthy();
    expect(screen.getByText('MOTIR-1793')).toBeTruthy();
  });

  it('filtered to one work item, only its lines show and the label is dropped', async () => {
    await mount(run(), 'wi_1', [
      logEvent(1, 'from a', 'MOTIR-1791'),
      logEvent(2, 'from b', 'MOTIR-1793'),
    ]);

    expect(screen.getByText('from a')).toBeTruthy();
    expect(screen.queryByText('from b')).toBeNull();
    // The source label is noise on every row when they all share one source.
    expect(screen.queryByText('MOTIR-1791')).toBeNull();
  });

  it('⚠️ a filter that SHRINKS the set does not crash the window', async () => {
    const evs = [logEvent(1, 'from a', 'MOTIR-1791'), logEvent(2, 'from b', 'MOTIR-1793')];
    const { rerender } = render(<RunLogPane run={run()} events={evs} selectedWorkItemId={null} />);
    await act(async () => {});
    expect(screen.getByText('from b')).toBeTruthy();

    // Two lines down to one — the shape a stale virtualized window crashes on.
    rerender(<RunLogPane run={run()} events={evs} selectedWorkItemId="wi_1" />);
    await act(async () => {});
    expect(screen.getByText('from a')).toBeTruthy();
    expect(screen.queryByText('from b')).toBeNull();
  });

  it('a line whose leg has no work item is not attributed to any selection', async () => {
    await mount(run(), 'wi_1', [logEvent(1, 'orphan', 'MOTIR-9999')]);
    expect(screen.queryByText('orphan')).toBeNull();
  });
});

describe('⚠️ FOLLOWING releases on an upward scroll and is re-armed only by the control', () => {
  it('offers no control while it is still following', async () => {
    await mount(run(), null, [logEvent(1, 'a line')]);
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();
  });

  it('releases when the reader scrolls up, and the control comes back', async () => {
    await mount(run(), null, [logEvent(1, 'a line')]);

    const body = screen.getByTestId('run-log-body');
    // happy-dom has no layout, so the scroll geometry is set explicitly: a tall
    // content, a short viewport, and a scrollTop well above the bottom.
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true });
    body.scrollTop = 100;
    fireEvent.scroll(body);

    expect(screen.getByRole('button', { name: 'Follow' })).toBeTruthy();
  });

  it('⚠️ does NOT steal the scroll position once following has been released', async () => {
    const evs = [logEvent(1, 'a line')];
    const { rerender } = render(<RunLogPane run={run()} events={evs} selectedWorkItemId={null} />);
    await act(async () => {});

    const body = screen.getByTestId('run-log-body');
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true });
    body.scrollTop = 100;
    fireEvent.scroll(body);

    // A re-render with new lines must leave the reader where they were.
    rerender(<RunLogPane run={run({ seq: 2 })} events={evs} selectedWorkItemId={null} />);
    await act(async () => {});
    expect(body.scrollTop).toBe(100);
  });

  it('the control resumes following and returns to the bottom', async () => {
    await mount(run(), null, [logEvent(1, 'a line')]);

    const body = screen.getByTestId('run-log-body');
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true });
    body.scrollTop = 100;
    fireEvent.scroll(body);

    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(body.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();
  });
});

// MOTIR-9069 — agent output WRAPS inside the log pane; no line is clipped behind
// a scroller of its own, and the gutter stays a hanging indent.
//
// ⚠️ WHAT THIS LANE CAN AND CANNOT ASSERT. happy-dom performs no layout: every box
// is 0×0, so `scrollWidth <= clientWidth` reads `0 <= 0` and is green on the
// UNFIXED component. A guard that cannot go red is not a guard, so this block
// asserts the MECHANISM — the classes that produce the geometry — the way
// `guide-rail-overflow.test.tsx` and `plan-review-rail-overflow.test.tsx` do. The
// real-browser geometry at a dragged width is the story's E2E (MOTIR-9076).

/** A token with NO line-break opportunity — no space, `/` or `-`. */
const UNBREAKABLE = `TOKEN_${'X'.repeat(64)}`;

/** Is `el` reached by `overflow-wrap: anywhere`? The property INHERITS, so the
 *  element itself or any ancestor up to the scroller counts. */
function reachedByWrapGuard(el: HTMLElement, scroller: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.classList.contains('wrap-anywhere')) return true;
    if (node === scroller) return false;
  }
  return false;
}

describe('⚠️ a long line WRAPS — nothing is clipped behind a scroller of its own', () => {
  it('states both overflow axes on the scroller, with no sideways bar', async () => {
    await mount(run(), null, [logEvent(1, 'a line')]);
    const scroller = screen.getByTestId('run-log-body');
    expect(scroller.classList.contains('overflow-x-hidden')).toBe(true);
    expect(scroller.classList.contains('overflow-y-auto')).toBe(true);
    expect(scroller.classList.contains('overflow-auto')).toBe(false);
  });

  it('gives the body cell whitespace-pre-wrap and no per-line scroller', async () => {
    await mount(run(), null, [logEvent(1, UNBREAKABLE)]);
    const body = screen.getByTestId('run-log-line-body');
    expect(body.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(body.classList.contains('min-w-0')).toBe(true);
    expect(body.classList.contains('overflow-x-auto')).toBe(false);
    // The row no longer forbids a soft break in its cells.
    expect(screen.getByTestId('run-log-line').classList.contains('whitespace-pre')).toBe(false);
  });

  it('reaches the body with wrap-anywhere, and renders an unbreakable token whole', async () => {
    await mount(run(), null, [logEvent(1, UNBREAKABLE)]);
    const scroller = screen.getByTestId('run-log-body');
    const body = screen.getByTestId('run-log-line-body');
    expect(body.textContent).toBe(UNBREAKABLE);
    expect(reachedByWrapGuard(body, scroller)).toBe(true);
    // No scroll container of its own anywhere between the token and the scroller.
    for (
      let node: HTMLElement | null = body;
      node && node !== scroller;
      node = node.parentElement
    ) {
      expect(node.className).not.toMatch(/overflow-(x-)?(auto|scroll)/);
    }
  });

  it('keeps both gutter cells flex-none and unwrappable, so the wrap lands under the body', async () => {
    await mount(run(), null, [logEvent(1, 'a line', 'MOTIR-1791')]);
    const line = screen.getByTestId('run-log-line');
    const body = screen.getByTestId('run-log-line-body');
    const gutter = Array.from(line.children).filter((c) => c !== body) as HTMLElement[];
    // Timestamp cell + work-item-key cell (unfiltered).
    expect(gutter).toHaveLength(2);
    for (const cell of gutter) {
      expect(cell.classList.contains('flex-none')).toBe(true);
      expect(cell.classList.contains('whitespace-nowrap')).toBe(true);
    }
    // The body is the one shrinkable cell.
    expect(line.classList.contains('flex')).toBe(true);
  });
});
