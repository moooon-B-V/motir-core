// IS THIS RUN STILL ALIVE? — the ONE rule (Story MOTIR-6526 · MOTIR-6528,
// `docs/decisions/run-death-keeps-work.md` §2).
//
// ⚠️ EVERY CALLER THAT ASKS THE QUESTION ASKS IT HERE. The *run died* marker, the
// continue claim and the lapse reap all need the same answer, and two copies of
// *is this run alive?* is how the card comes to say a run died while the claim
// still refuses to take it over, or the other way round. So the rule is a pure
// function of the row and a clock, with no server imports, readable by a service
// and a client island alike.
//
// ⚠️ LIVENESS IS A TIMESTAMP AND A RULE, NOT A STATE. Nothing is written when a
// run "becomes dead": the rule is evaluated at read time, so the marker and the
// claim know within seconds of the lapse, and the sweep that closes the row
// `abandoned` is housekeeping that makes the RECORD say so — nothing waits on it.
//
// THE THREE POPULATIONS, each keeping its own meaning:
//
//   * HOSTED — alive while `running`. It sends no heartbeat: its server-side
//     supervision owns its liveness (the 15-minute stall, a lost chain), and
//     9.1's end path is what closes it.
//   * LOCAL, HEARTBEATING — alive while its last heartbeat is younger than the
//     lapse window. Five missed beats, so one late report is never a death.
//   * LOCAL, LEGACY (`lastHeartbeatAt === null`, a CLI too old to heartbeat) —
//     alive until the existing 12-hour age reap would close it. Never marked
//     dead before then: it cannot prove it is alive, so absence proves nothing.

/** How often a local run reports it is alive. */
export const RUN_HEARTBEAT_INTERVAL_MS = 60_000;

/** How long a local run may be silent before it is dead — five missed beats. */
export const RUN_HEARTBEAT_LAPSE_MS = 300_000;

/**
 * How long a run that never heartbeats may stay `running` — the age reap's
 * threshold (`DISPATCH_RUN_ABANDON_AFTER_HOURS`), restated in milliseconds HERE
 * rather than imported, so this module stays free of server imports. A test
 * pins the two to each other.
 */
export const RUN_LEGACY_ALIVE_MS = 12 * 60 * 60 * 1000;

/** The columns the rule reads — any run row or DTO carries them. */
export interface RunLivenessInput {
  status: string;
  origin: 'local' | 'hosted';
  startedAt: Date | string;
  lastHeartbeatAt: Date | string | null;
}

function ms(at: Date | string): number {
  return typeof at === 'string' ? Date.parse(at) : at.getTime();
}

/** Whether the run is still working, as of `now`. */
export function isRunAlive(run: RunLivenessInput, now: Date = new Date()): boolean {
  if (run.status !== 'running') return false;
  if (run.origin === 'hosted') return true;
  if (run.lastHeartbeatAt !== null) {
    return now.getTime() - ms(run.lastHeartbeatAt) < RUN_HEARTBEAT_LAPSE_MS;
  }
  return now.getTime() - ms(run.startedAt) < RUN_LEGACY_ALIVE_MS;
}

/**
 * When the run was last heard from — its last heartbeat, else its start. The
 * instant the *run died* marker names.
 */
export function lastHeardFrom(run: Pick<RunLivenessInput, 'startedAt' | 'lastHeartbeatAt'>): Date {
  return new Date(ms(run.lastHeartbeatAt ?? run.startedAt));
}
