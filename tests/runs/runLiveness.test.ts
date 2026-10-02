import { describe, expect, it } from 'vitest';
import {
  isRunAlive,
  lastHeardFrom,
  RUN_HEARTBEAT_INTERVAL_MS,
  RUN_HEARTBEAT_LAPSE_MS,
  RUN_LEGACY_ALIVE_MS,
} from '@/lib/runs/runLiveness';
import { DISPATCH_RUN_ABANDON_AFTER_HOURS } from '@/lib/services/dispatchRunService';

// `isRunAlive` (Story MOTIR-6526 · MOTIR-6528) — the ONE rule every caller asks
// *is this run still working?* through. Every row of its table
// (`docs/decisions/run-death-keeps-work.md` §2), each population keeping its own
// meaning.

const NOW = new Date('2026-09-27T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('isRunAlive — the table', () => {
  it('a CLOSED run is never alive, whatever it last reported', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'timed_out']) {
      expect(
        isRunAlive(
          { status, origin: 'local', startedAt: minutesAgo(2), lastHeartbeatAt: minutesAgo(0) },
          NOW,
        ),
      ).toBe(false);
    }
  });

  it('a HOSTED run is alive while `running` — its supervision owns its liveness', () => {
    expect(
      isRunAlive(
        { status: 'running', origin: 'hosted', startedAt: minutesAgo(600), lastHeartbeatAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it('a local run that beat 4 minutes ago is alive; 6 minutes ago it is dead', () => {
    const run = (beat: number) => ({
      status: 'running',
      origin: 'local' as const,
      startedAt: minutesAgo(120),
      lastHeartbeatAt: minutesAgo(beat),
    });
    expect(isRunAlive(run(4), NOW)).toBe(true);
    expect(isRunAlive(run(6), NOW)).toBe(false);
  });

  it('a heartbeating run is alive however LONG it has run — age is not the test', () => {
    expect(
      isRunAlive(
        {
          status: 'running',
          origin: 'local',
          startedAt: minutesAgo(30 * 60),
          lastHeartbeatAt: minutesAgo(1),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('a LEGACY local run (no heartbeat ever) is alive at 1 h and dead at 13 h — the age reap’s rule', () => {
    const legacy = (hours: number) => ({
      status: 'running',
      origin: 'local' as const,
      startedAt: minutesAgo(hours * 60),
      lastHeartbeatAt: null,
    });
    expect(isRunAlive(legacy(1), NOW)).toBe(true);
    expect(isRunAlive(legacy(13), NOW)).toBe(false);
  });

  // MOTIR-7328: a current CLI beats the moment it holds a run, so a run killed in
  // its first seconds carries `lastHeartbeatAt` ≈ `startedAt` and is dead at
  // `startedAt + RUN_HEARTBEAT_LAPSE_MS`, not at the legacy 12 hours.
  it('a current CLI’s run killed seconds after its open beat is dead once the lapse passes', () => {
    const startedAt = minutesAgo(13);
    const killedEarly = {
      status: 'running',
      origin: 'local' as const,
      startedAt,
      lastHeartbeatAt: new Date(startedAt.getTime() + 200),
    };
    const lapse = startedAt.getTime() + 200 + RUN_HEARTBEAT_LAPSE_MS;
    expect(isRunAlive(killedEarly, new Date(lapse - 1))).toBe(true);
    expect(isRunAlive(killedEarly, new Date(lapse))).toBe(false);
    // 13 minutes after the kill — the reporter's two refused continues — it is dead.
    expect(isRunAlive(killedEarly, NOW)).toBe(false);
    // The same run with no beat at all is still the LEGACY population, and keeps
    // the age reap's 12-hour rule.
    expect(isRunAlive({ ...killedEarly, lastHeartbeatAt: null }, NOW)).toBe(true);
  });

  it('reads ISO strings exactly as it reads Dates, so a DTO and a row agree', () => {
    expect(
      isRunAlive(
        {
          status: 'running',
          origin: 'local',
          startedAt: minutesAgo(60).toISOString(),
          lastHeartbeatAt: minutesAgo(6).toISOString(),
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe('the numbers', () => {
  it('60 s interval, 5 min lapse — five missed beats', () => {
    expect(RUN_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(RUN_HEARTBEAT_LAPSE_MS).toBe(5 * RUN_HEARTBEAT_INTERVAL_MS);
  });

  it('the legacy window IS the age reap’s threshold, restated without a server import', () => {
    expect(RUN_LEGACY_ALIVE_MS).toBe(DISPATCH_RUN_ABANDON_AFTER_HOURS * 60 * 60 * 1000);
  });

  it('lastHeardFrom is the last beat, else the start', () => {
    expect(lastHeardFrom({ startedAt: minutesAgo(9), lastHeartbeatAt: minutesAgo(3) })).toEqual(
      minutesAgo(3),
    );
    expect(lastHeardFrom({ startedAt: minutesAgo(9), lastHeartbeatAt: null })).toEqual(
      minutesAgo(9),
    );
  });
});
