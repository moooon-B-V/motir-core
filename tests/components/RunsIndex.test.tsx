// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunsIndex } from '@/app/(authed)/runs/_components/RunsIndex';
import type { DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';

// THE RUNS INDEX (Story MOTIR-1789 · MOTIR-3923).
//
// The design decides three things this file exists to hold in place, each of
// which fails differently and none of which is visible from the happy path:
// two SECTIONS rather than a switch, an empty section that STAYS, and a failed
// read that never wears the empty state's face.

// The URL is the modal's OPEN STATE (MOTIR-3895), so the index reads
// `useSearchParams`. Mutable, so a test can assert the deep-link arm.
let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => params,
}));

// The modal has its OWN suite (`RunModal.test.tsx`) and its own reads; here it
// stands in for itself so the assertions are about the INDEX's decision to
// mount it at all.
vi.mock('@/app/(authed)/runs/_components/RunModal', () => ({
  RunModal: ({ runId }: { runId: string }) => <div data-testid="run-modal">{runId}</div>,
}));

const fetchMock = vi.fn();
beforeEach(() => {
  params = new URLSearchParams();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ runs: [] }) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NO_LEGS = {
  queued: 0,
  running: 0,
  integrated: 0,
  implemented: 0,
  failed: 0,
  replanned: 0,
  skipped: 0,
  not_reached: 0,
};

function run(over: Partial<DispatchRunListItemDto> = {}): DispatchRunListItemDto {
  return {
    id: 'run_1',
    command: 'run',
    origin: 'local',
    scopeWorkItemId: 'itm_1',
    scopeLabel: 'Agent runs',
    status: 'succeeded',
    stopReason: 'drained',
    agent: 'claude',
    model: 'opus-5',
    startedAt: '2026-08-30T14:02:11.000Z',
    endedAt: '2026-08-30T14:23:11.000Z',
    createdById: 'usr_1',
    cardCount: 11,
    legs: { ...NO_LEGS, implemented: 9, skipped: 1, not_reached: 1 },
    ...over,
  };
}

const mount = (live: DispatchRunListItemDto[] | null, past: DispatchRunListItemDto[] | null) =>
  render(<RunsIndex projectKey="PROD" initialLive={live} initialPast={past} pageSize={25} />);

describe('⚠️ TWO SECTIONS, not a switch — and neither disappears', () => {
  it('shows both headings at once, with no control to choose between them', () => {
    mount([run({ id: 'r_live', status: 'running' })], [run()]);
    expect(screen.getByText('Running now')).toBeTruthy();
    expect(screen.getByText('Past runs')).toBeTruthy();
    // A switch would make one of the two answers cost a click. There is none.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('⚠️ nothing running keeps the heading and states the fact', () => {
    // The ORDINARY case. "A section that vanishes makes a reader wonder whether
    // it failed" — so the heading stays and one line says what is true.
    mount([], [run()]);
    expect(screen.getByText('Running now')).toBeTruthy();
    expect(screen.getByText('Nothing is running.')).toBeTruthy();
  });

  it('nothing has EVER run reads as a fact, not an error', () => {
    mount([], []);
    expect(screen.getByText('Nothing has run yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('⚠️ a FAILED read and an EMPTY one are opposite facts', () => {
  it('a failed section says so, and never borrows the empty line', () => {
    mount(null, [run()]);
    expect(screen.getByText(/couldn’t load these runs/i)).toBeTruthy();
    expect(screen.queryByText('Nothing is running.')).toBeNull();
  });

  it('a failed read does not masquerade as “nothing has run yet”', () => {
    mount(null, null);
    expect(screen.queryByText('Nothing has run yet')).toBeNull();
    expect(screen.getAllByText(/couldn’t load these runs/i)).toHaveLength(2);
  });
});

describe('the row carries the run’s OUTCOME, and survives its subject', () => {
  it('summarises the legs rather than listing them', () => {
    mount([], [run()]);
    expect(screen.getByText(/9 of 11 done/)).toBeTruthy();
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
  });

  it('a run that took NO work items says so — zero is a real answer', () => {
    mount([], [run({ cardCount: 0, legs: NO_LEGS })]);
    expect(screen.getByText('Took no work items')).toBeTruthy();
  });

  it('⚠️ a deleted scope still renders — the LABEL is stored beside the id', () => {
    mount([], [run({ scopeWorkItemId: null, scopeLabel: 'Agent runs' })]);
    expect(screen.getByText('Agent runs')).toBeTruthy();
  });

  it('the STOP REASON is deliberately not a column', () => {
    // "It is one sentence and it belongs on the run, where there is room to say
    // it in words." A column would truncate it into a word that reads as a code.
    mount([], [run({ stopReason: 'halted' })]);
    expect(screen.queryByText('halted')).toBeNull();
  });
});

describe('⚠️ it polls only while something is LIVE, and opens no stream', () => {
  it('a list with no live run makes no request at all', async () => {
    mount([], [run()]);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('and never opens a per-row stream', async () => {
    mount([run({ status: 'running' })], [run(), run({ id: 'r2' })]);
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/stream'))).toEqual([]);
  });
});

describe('⚠️ the close-out — what the list does when the run it is showing ENDS', () => {
  it('an EMPTY list still renders an open run: the reader was watching it', () => {
    // The bug: the both-empty early return sat ABOVE the modal, so a list that
    // went empty unmounted an open run out from under the reader — while the URL
    // kept its `?run=`, because nothing called `onCloseRun`. The page then read
    // *Nothing has run yet* over a run that had just finished.
    params = new URLSearchParams('run=run_open');
    mount([], []);

    expect(screen.getByText('Nothing has run yet')).toBeTruthy();
    // The modal answers to `openRunId`, never to how many rows the list holds.
    expect(screen.getByTestId('run-modal').textContent).toBe('run_open');
  });

  it('re-reads PAST as soon as a run LEAVES the live list, and RENDERS it', async () => {
    // Polling only the live half is what emptied the page: `live` went to zero
    // and `past` still held the answer from page load — taken while that same
    // run was live.
    //
    // ⚠️ THE PAST READ IS HELD OPEN ACROSS A RE-RENDER, deliberately, and that
    // is the only reason this test can see the bug it exists for. Committing the
    // empty `live` list flips `anyLive` — the poll effect's OWN dependency — so
    // React tears the interval down and the cleanup sets `cancelled`, which then
    // discards the in-flight `past` response. Resolving both fetches inside one
    // `act` scope hides that entirely: an earlier version of this test asserted
    // only that a `status=past` request was MADE, passed, and the page went on
    // going empty in a real browser. The gate forces the interleaving.
    vi.useFakeTimers();
    try {
      let releasePast: () => void = () => {};
      const pastGate = new Promise<void>((resolve) => {
        releasePast = resolve;
      });
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).includes('status=live')) {
          return { ok: true, json: async () => ({ runs: [] }) };
        }
        await pastGate;
        return { ok: true, json: async () => ({ runs: [run({ id: 'r_settled' })] }) };
      });
      mount([run({ id: 'r_settled', status: 'running' })], []);

      // The poll fires and sees an empty `live`. The past read is still open.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000 + 50);
      });
      // Only now does the past half answer — after any teardown has happened.
      await act(async () => {
        releasePast();
        await Promise.resolve();
      });

      const readPast = fetchMock.mock.calls.some((c) => String(c[0]).includes('status=past'));
      expect(readPast, 'the settled run was never looked for in `past`').toBe(true);
      // ⚠️ ASSERTED ON WHAT RENDERS. A request proves an intent; the surviving
      // headings prove the reader got the answer. If the past read is dropped,
      // both halves are empty and the empty state replaces them — the bug.
      expect(screen.queryByText('Nothing has run yet')).toBeNull();
      expect(screen.getByText('Past runs')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
