// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunLogPane } from '@/app/(authed)/runs/_components/RunLogPane';
import type { DispatchRunCardDto, DispatchRunDto } from '@/lib/dto/dispatchRuns';

// THE LOG PANE of the run modal (Story MOTIR-1789 · MOTIR-3962).
//
// ⚠️ THE THREE SILENCES ARE THE LOAD-BEARING PART. Sending log bodies is opt-in
// and off by default, so the ORDINARY run has nothing here — and one message for
// all three tells a person their run failed to record when in fact they chose
// that, or when the record simply aged out. Each is asserted separately, because
// collapsing them is exactly the defect that would still look correct.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // Default: a stream that opens and never yields — the tests that care supply
  // their own body.
  fetchMock.mockResolvedValue({
    ok: true,
    body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    cards: [leg(), leg({ id: 'leg_2', key: 'MOTIR-1793', workItemId: 'wi_2' })],
    seq: 0,
    ...over,
  };
}

/** An SSE body that yields these frames once, then ends. */
function sse(frames: string[]): { getReader: () => { read: () => Promise<unknown> } } {
  const chunks = frames.map((f) => new TextEncoder().encode(f));
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
    }),
  };
}

function logFrame(seq: number, body: string, workItemKey?: string): string {
  const ev = {
    id: `e${seq}`,
    seq,
    kind: 'log',
    cardId: 'leg_1',
    data: workItemKey === undefined ? null : { workItemKey },
    body,
    createdAt: '2026-08-30T14:02:00.000Z',
  };
  return `event: event\ndata: ${JSON.stringify(ev)}\n\n`;
}

async function mount(dto: DispatchRunDto, selected: string | null = null): Promise<void> {
  render(<RunLogPane run={dto} selectedWorkItemId={selected} />);
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
    fetchMock.mockResolvedValue({
      ok: true,
      body: sse([logFrame(1, 'first line'), logFrame(2, 'second line')]),
    });
    await mount(run());

    expect(screen.getByText('first line')).toBeTruthy();
    expect(screen.getByText('second line')).toBeTruthy();
    // ⚠️ `since=0`, not the run's own `seq` — starting at the head is what makes
    // the backfill arrive at all.
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/dispatch-runs/run_1/stream?since=0');
  });

  it('orders by SEQ, not by arrival', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sse([logFrame(9, 'later'), logFrame(2, 'earlier')]),
    });
    await mount(run());

    const body = screen.getByTestId('run-log-body');
    expect(body.textContent!.indexOf('earlier')).toBeLessThan(body.textContent!.indexOf('later'));
  });

  it('a REPLAYED seq is one line, not two — the reconnect contract', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sse([logFrame(1, 'only once'), logFrame(1, 'only once')]),
    });
    await mount(run());

    expect(screen.getAllByText('only once')).toHaveLength(1);
  });

  it('ignores every event kind that is not a log', async () => {
    const other = `event: event\ndata: ${JSON.stringify({
      id: 'e1',
      seq: 1,
      kind: 'card_settled',
      cardId: null,
      data: null,
      body: null,
      createdAt: '2026-08-30T14:02:00.000Z',
    })}\n\n`;
    fetchMock.mockResolvedValue({ ok: true, body: sse([other]) });
    await mount(run());

    // No lines ⇒ still a silence, not an empty console.
    expect(screen.getByTestId('run-log-silence-neverSent')).toBeTruthy();
  });
});

describe('the FILTER follows the modal’s selection', () => {
  it('unfiltered, every line names its source member', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sse([logFrame(1, 'from a', 'MOTIR-1791'), logFrame(2, 'from b', 'MOTIR-1793')]),
    });
    await mount(run(), null);

    expect(screen.getByText('MOTIR-1791')).toBeTruthy();
    expect(screen.getByText('MOTIR-1793')).toBeTruthy();
  });

  it('filtered to one work item, only its lines show and the label is dropped', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sse([logFrame(1, 'from a', 'MOTIR-1791'), logFrame(2, 'from b', 'MOTIR-1793')]),
    });
    await mount(run(), 'wi_1');

    expect(screen.getByText('from a')).toBeTruthy();
    expect(screen.queryByText('from b')).toBeNull();
    // The source label is noise on every row when they all share one source.
    expect(screen.queryByText('MOTIR-1791')).toBeNull();
  });

  it('⚠️ a filter that SHRINKS the set does not crash the window', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sse([logFrame(1, 'from a', 'MOTIR-1791'), logFrame(2, 'from b', 'MOTIR-1793')]),
    });
    const { rerender } = render(<RunLogPane run={run()} selectedWorkItemId={null} />);
    await act(async () => {});
    expect(screen.getByText('from b')).toBeTruthy();

    // Two lines down to one — the shape a stale virtualized window crashes on.
    rerender(<RunLogPane run={run()} selectedWorkItemId="wi_1" />);
    await act(async () => {});
    expect(screen.getByText('from a')).toBeTruthy();
    expect(screen.queryByText('from b')).toBeNull();
  });

  it('a line whose leg has no work item is not attributed to any selection', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: sse([logFrame(1, 'orphan', 'MOTIR-9999')]) });
    await mount(run(), 'wi_1');
    expect(screen.queryByText('orphan')).toBeNull();
  });
});

describe('⚠️ FOLLOWING releases on an upward scroll and is re-armed only by the control', () => {
  it('offers no control while it is still following', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: sse([logFrame(1, 'a line')]) });
    await mount(run());
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();
  });

  it('releases when the reader scrolls up, and the control comes back', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: sse([logFrame(1, 'a line')]) });
    await mount(run());

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
    fetchMock.mockResolvedValue({ ok: true, body: sse([logFrame(1, 'a line')]) });
    const { rerender } = render(<RunLogPane run={run()} selectedWorkItemId={null} />);
    await act(async () => {});

    const body = screen.getByTestId('run-log-body');
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true });
    body.scrollTop = 100;
    fireEvent.scroll(body);

    // A re-render with new lines must leave the reader where they were.
    rerender(<RunLogPane run={run({ seq: 2 })} selectedWorkItemId={null} />);
    await act(async () => {});
    expect(body.scrollTop).toBe(100);
  });

  it('the control resumes following and returns to the bottom', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: sse([logFrame(1, 'a line')]) });
    await mount(run());

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
