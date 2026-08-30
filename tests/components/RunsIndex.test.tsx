// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunsIndex } from '@/app/(authed)/runs/_components/RunsIndex';
import type { DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';

// THE RUNS INDEX (Story MOTIR-1789 · MOTIR-3923).
//
// The design decides three things this file exists to hold in place, each of
// which fails differently and none of which is visible from the happy path:
// two SECTIONS rather than a switch, an empty section that STAYS, and a failed
// read that never wears the empty state's face.

const fetchMock = vi.fn();
beforeEach(() => {
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
