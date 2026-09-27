import { describe, expect, it } from 'vitest';
import {
  HOSTED_PHASES,
  hostedEndKind,
  machineTimeParts,
  readHostedPhases,
  stoppedInPhase,
} from '@/lib/runs/hostedRun';
import type { DispatchEventKind } from '@/lib/dto/dispatchRuns';

// A HOSTED run's phases and end, as the run surfaces read them (Story MOTIR-683 ·
// MOTIR-691; `design/runs/design-notes.md` § The hosted PHASES / § The END states).

const ev = (...kinds: DispatchEventKind[]) => kinds.map((kind) => ({ kind }));

describe('the six phases, on existing event kinds only', () => {
  it('a run that just opened is Starting, 1 of 6', () => {
    const read = readHostedPhases({
      events: ev('run_opened'),
      status: 'running',
      hasPullRequest: false,
    });
    expect([...read.reached]).toEqual(['starting']);
    expect(read.current).toBe('starting');
    expect(read.position).toBe(1);
  });

  it('checkout → agent → exit walks Cloned, Running, Agent finished', () => {
    const read = readHostedPhases({
      events: ev('run_opened', 'checkout_ready', 'agent_started', 'log', 'agent_exited'),
      status: 'running',
      hasPullRequest: false,
    });
    expect(read.current).toBe('finished');
    expect(read.position).toBe(4);
  });

  it('a linked pull request reaches Pull request open without a delivery_linked event', () => {
    const read = readHostedPhases({
      events: ev('run_opened', 'checkout_ready', 'agent_started', 'agent_exited'),
      status: 'running',
      hasPullRequest: true,
    });
    expect(read.current).toBe('pullRequest');
    expect(read.position).toBe(5);
  });

  it('⚠️ a log line before the clone does not count as Running (the end path writes a log too)', () => {
    const read = readHostedPhases({
      events: ev('run_opened', 'log'),
      status: 'failed',
      hasPullRequest: false,
    });
    expect(read.reached.has('running')).toBe(false);
    expect(stoppedInPhase(read)).toBe('starting');
  });

  it('a succeeded run reaches all six', () => {
    const read = readHostedPhases({ events: [], status: 'succeeded', hasPullRequest: true });
    expect([...read.reached].sort()).toEqual([...HOSTED_PHASES].sort());
    expect(read.current).toBeNull();
    expect(read.position).toBe(6);
  });

  it('a failed run is Done and marks the phase it stopped in', () => {
    const read = readHostedPhases({
      events: ev('run_opened', 'checkout_ready', 'agent_started'),
      status: 'failed',
      hasPullRequest: false,
    });
    expect(read.reached.has('done')).toBe(true);
    expect(stoppedInPhase(read)).toBe('running');
  });
});

describe('the END — stalled and timed out share a status and differ by the recorded outcome', () => {
  const end = (outcome: string | null) => ({ outcome, detail: null, exitCode: null });
  it.each([
    ['succeeded', null, 'succeeded'],
    ['cancelled', 'cancelled', 'cancelled'],
    ['timed_out', 'stall', 'stalled'],
    ['timed_out', 'backstop', 'timedOut'],
    ['timed_out', 'lost_supervision', 'lostSupervision'],
    ['failed', 'exited', 'crashed'],
    ['failed', 'failed', 'failed'],
    // A run the CLI closed itself carries no outcome.
    ['failed', null, 'failed'],
  ] as const)('%s + %s → %s', (status, outcome, kind) => {
    expect(hostedEndKind(status, end(outcome))).toBe(kind);
  });

  it('a live run has no end', () => {
    expect(hostedEndKind('running', undefined)).toBeNull();
  });
});

describe('machine time as h · min · s, zero units dropped', () => {
  it.each([
    [0, [{ unit: 's', n: 0 }]],
    [59, [{ unit: 's', n: 59 }]],
    [60, [{ unit: 'min', n: 1 }]],
    [
      1592,
      [
        { unit: 'min', n: 26 },
        { unit: 's', n: 32 },
      ],
    ],
    [3600, [{ unit: 'h', n: 1 }]],
    [
      3661,
      [
        { unit: 'h', n: 1 },
        { unit: 'min', n: 1 },
        { unit: 's', n: 1 },
      ],
    ],
  ] as const)('%i s', (seconds, parts) => {
    expect(machineTimeParts(seconds)).toEqual(parts);
  });
});
