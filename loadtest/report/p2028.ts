// P2028, COUNTED FROM THE PLATFORM (Story MOTIR-8538 · MOTIR-8679).
//
// The authoritative reading is Fly's managed Prometheus: per staging `app`
// instance, `db_tx_wait_seconds_count{outcome=~"p2028_.*"}` at `window.endedAt`
// MINUS the same at `window.startedAt` (absent = 0), split by half — over the WHOLE
// run, ramp included, because a P2028 during the ramp is still a P2028.
//
// A POSITIVE CONTROL accompanies every instance: its `committed` count must have
// risen over the window. If it did not (an unscraped or restarted instance), that
// instance's reading is `unmeasured`, never 0. Log silence is not evidence of zero:
// the app writes no P2028 line to stdout. The log lines are CORROBORATION: they can
// turn the line FAIL (any count on any channel is a FAIL), never PASS.
//
// ⚠️ BLIND SPOT, printed in the line: `p2028_*` counts failures BEFORE the
// transaction body ran (lib/monitoring/transactionSpan.ts `failedOutcome`); a
// failure after the body started is labelled `rolled_back`, so a mid-body expiry is
// not in this count — it shows up as an `error` outcome in the latency lines.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Gap } from '../capture/appLogs';
import type { Reading } from './inputs';
import { counterDelta, sel, widen, type PromClient } from './prometheus';
import type { LineStatus } from './thresholds';

// Copied from lib/monitoring/transactionStall.ts (module-private there): the two
// halves of a P2028 message. `MAX_WAIT_MESSAGE` is the wait half; any other
// `Transaction API error` is the timeout half.
const MAX_WAIT_MESSAGE = /Unable to start a transaction in the given time/i;
const TRANSACTION_API_MESSAGE = /Transaction API error/i;

export const P2028_HALVES = ['p2028_wait', 'p2028_timeout'] as const;
export type P2028Half = (typeof P2028_HALVES)[number];

export const P2028_BLIND_SPOT =
  'Blind spot: p2028_* counts only failures before the transaction body ran ' +
  '(lib/monitoring/transactionSpan.ts failedOutcome); a mid-body expiry is labelled ' +
  'rolled_back and shows as an error outcome in the latency lines, not here.';

export interface InstanceP2028 {
  instance: string;
  p2028_wait: number | null;
  p2028_timeout: number | null;
  /** The `committed` positive control's rise over the window; null when unreadable. */
  committedRise: number | null;
  measured: boolean;
  reason: string | null;
}

export interface LogCrossCheck {
  state: 'complete' | 'incomplete' | 'unmeasured';
  reason: string | null;
  total: number;
  byInstance: Record<string, Record<P2028Half, number>>;
  /** True when the platform was read and the log count differs from it. */
  disagrees: boolean;
}

export interface P2028Reading {
  status: LineStatus;
  total: number | null;
  limit: number;
  instances: InstanceP2028[];
  reason: string | null;
  logs: LogCrossCheck;
  blindSpot: string;
}

/** The half a log message belongs to, or null when it is not a P2028 line. */
export function p2028HalfOf(message: string): P2028Half | null {
  if (MAX_WAIT_MESSAGE.test(message)) return 'p2028_wait';
  if (TRANSACTION_API_MESSAGE.test(message)) return 'p2028_timeout';
  return null;
}

export async function readPlatformP2028(opts: {
  prom: PromClient;
  machineIds: string[] | null;
  window: { start: number; end: number };
}): Promise<{ instances: InstanceP2028[] } | { unmeasured: string }> {
  const { start, end } = widen(opts.window.start, opts.window.end);
  const app = opts.prom.app;
  const failures = await counterDelta(
    opts.prom,
    `sum by (instance, outcome) (db_tx_wait_seconds_count${sel(app, 'outcome=~"p2028_.*"')})`,
    start,
    end,
    ['instance', 'outcome'],
  );
  if (failures.state !== 'ok') return { unmeasured: failures.reason };
  const control = await counterDelta(
    opts.prom,
    `sum by (instance) (db_tx_wait_seconds_count${sel(app, 'outcome="committed"')})`,
    start,
    end,
    ['instance'],
  );
  if (control.state !== 'ok') return { unmeasured: control.reason };

  const ids = new Set(opts.machineIds ?? []);
  for (const k of [...failures.value.keys(), ...control.value.keys()]) {
    const id = /instance=([^,]*)/.exec(k)?.[1];
    if (id) ids.add(id);
  }
  const instances = [...ids].sort().map((instance): InstanceP2028 => {
    const half = (h: P2028Half) => {
      const k = `instance=${instance},outcome=${h}`;
      return failures.value.has(k) ? failures.value.get(k)! : 0;
    };
    const wait = half('p2028_wait');
    const timeout = half('p2028_timeout');
    const rise = control.value.get(`instance=${instance}`);
    const committedRise = rise === undefined ? 0 : rise;
    let reason: string | null = null;
    if (wait === null || timeout === null) reason = 'its p2028 counter went backwards (a restart)';
    else if (committedRise === null) reason = 'its committed counter went backwards (a restart)';
    else if (committedRise <= 0)
      reason = 'the committed positive control did not rise (unscraped or restarted)';
    return {
      instance,
      p2028_wait: wait,
      p2028_timeout: timeout,
      committedRise,
      measured: reason === null,
      reason,
    };
  });
  return { instances };
}

/** Count the P2028 log lines in the run window, by half and machine. */
export async function readLogP2028(opts: {
  appLogs: Reading<string>;
  gaps: Reading<Gap[]>;
  window: { start: number; end: number };
}): Promise<Omit<LogCrossCheck, 'disagrees'>> {
  const byInstance: Record<string, Record<P2028Half, number>> = {};
  if (opts.appLogs.state !== 'ok') {
    return { state: 'unmeasured', reason: opts.appLogs.reason, total: 0, byInstance };
  }
  const { start, end } = widen(opts.window.start, opts.window.end);
  let total = 0;
  const lines = createInterface({
    input: createReadStream(opts.appLogs.value),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const half = p2028HalfOf(String(e['message'] ?? ''));
    if (!half) continue;
    const t = Date.parse(String(e['timestamp'] ?? ''));
    if (!Number.isNaN(t) && (t < start.getTime() || t > end.getTime())) continue;
    const id = String(e['instance'] ?? 'unknown');
    byInstance[id] ??= { p2028_wait: 0, p2028_timeout: 0 };
    byInstance[id][half] += 1;
    total += 1;
  }
  let state: LogCrossCheck['state'] = 'complete';
  let reason: string | null = null;
  if (opts.gaps.state !== 'ok') {
    state = 'incomplete';
    reason = `the gap record is unreadable: ${opts.gaps.reason}`;
  } else {
    const overlapping = opts.gaps.value.filter(
      (g) => Date.parse(g.to) >= opts.window.start && Date.parse(g.from) <= opts.window.end,
    );
    if (overlapping.length > 0) {
      state = 'incomplete';
      reason = `${overlapping.length} log-stream gap(s) overlap the run window`;
    }
  }
  return { state, reason, total, byInstance };
}

export function judgeP2028(
  platform: { instances: InstanceP2028[] } | { unmeasured: string },
  logs: Omit<LogCrossCheck, 'disagrees'>,
  limit: number,
): P2028Reading {
  // Any count above the limit on ANY channel is a FAIL; the logs can fail a line, never pass one.
  const logsFail = logs.state !== 'unmeasured' && logs.total > limit;
  if ('unmeasured' in platform) {
    return {
      status: logsFail ? 'FAIL' : 'unmeasured',
      total: null,
      limit,
      instances: [],
      reason: `the platform count is unreadable (${platform.unmeasured}); log silence is not evidence of zero`,
      logs: { ...logs, disagrees: false },
      blindSpot: P2028_BLIND_SPOT,
    };
  }
  const total = platform.instances.reduce(
    (a, i) => a + (i.p2028_wait ?? 0) + (i.p2028_timeout ?? 0),
    0,
  );
  const unmeasuredOnes = platform.instances.filter((i) => !i.measured);
  let status: LineStatus;
  let reason: string | null = null;
  if (total > limit || logsFail) status = 'FAIL';
  else if (platform.instances.length === 0) {
    status = 'unmeasured';
    reason = 'no staging instance reported db_tx_wait_seconds_count';
  } else if (unmeasuredOnes.length > 0) {
    status = 'unmeasured';
    reason = unmeasuredOnes.map((i) => `${i.instance}: ${i.reason}`).join('; ');
  } else status = 'PASS';
  return {
    status,
    total,
    limit,
    instances: platform.instances,
    reason,
    logs: { ...logs, disagrees: logs.state !== 'unmeasured' && logs.total !== total },
    blindSpot: P2028_BLIND_SPOT,
  };
}
