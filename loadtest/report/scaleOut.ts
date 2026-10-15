// SCALE-OUT, AGAINST A NAMED 1-INSTANCE BASELINE (Story MOTIR-8538 · MOTIR-8679).
//
// At N > 1: served rps at N ≥ `efficiency` × N × the baseline report's served rps.
//
// The baseline is USABLE when its verdict is PASS, FAIL or UNMEASURED — scale-out
// compares served rps with served rps, so a baseline that missed its own target
// still anchors the line. It is `unmeasured` when its report is missing, its verdict
// is INVALID, its profile LOAD HASH differs, or its machine size differs.
//
// ROUTING IS CHECKED BEFORE SCALING IS JUDGED: Fly's proxy fills toward
// `soft_limit` before it spills to another machine, so load need not split evenly.
// Each instance's share of requests over the steady window comes from
// `fly_app_http_responses_count` by instance (falling back to
// `db_tx_wait_seconds_count` by instance as a proxy for load); a share outside
// ±25 % of 1/N makes the line `unmeasured` — routing, not scaling — never a FAIL.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ok, unmeasured, type Reading } from './inputs';
import { counterDelta, sel, widen, type PromClient } from './prometheus';
import type { Line } from './thresholds';

export const SHARE_TOLERANCE = 0.25;

/** The fields of a report.json the scale-out line reads. */
export interface BaselineReport {
  verdict: string;
  servedRps: number | null;
  header: { profile: { loadHash: string }; app: { size: string } };
}

export async function readBaseline(
  dir: string,
  current: { loadHash: string; size: string },
): Promise<Reading<{ dir: string; servedRps: number; verdict: string }>> {
  let r: BaselineReport;
  try {
    r = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as BaselineReport;
  } catch {
    return unmeasured(`the baseline report ${join(dir, 'report.json')} is missing or unreadable`);
  }
  if (r.verdict === 'INVALID') return unmeasured('the baseline report is INVALID');
  if (r.header?.profile?.loadHash !== current.loadHash)
    return unmeasured('the baseline ran a different load (its profile load hash differs)');
  if (r.header?.app?.size !== current.size)
    return unmeasured(
      `the baseline ran on a different machine size (${r.header?.app?.size} ≠ ${current.size})`,
    );
  if (typeof r.servedRps !== 'number') return unmeasured('the baseline report has no served rps');
  return ok({ dir, servedRps: r.servedRps, verdict: r.verdict });
}

export interface RoutingShares {
  source: 'fly_app_http_responses_count' | 'db_tx_wait_seconds_count';
  shares: Record<string, number>;
  balanced: boolean;
}

export async function readRoutingShares(
  prom: PromClient,
  steady: { start: number; end: number },
  n: number,
): Promise<Reading<RoutingShares>> {
  const { start, end } = widen(steady.start, steady.end);
  let last = 'no per-instance request series';
  for (const source of ['fly_app_http_responses_count', 'db_tx_wait_seconds_count'] as const) {
    const d = await counterDelta(
      prom,
      `sum by (instance) (${source}${sel(prom.app)})`,
      start,
      end,
      ['instance'],
    );
    if (d.state !== 'ok') {
      last = d.reason;
      continue;
    }
    const counts = [...d.value.entries()].filter(([, v]) => v !== null) as [string, number][];
    const total = counts.reduce((a, [, v]) => a + v, 0);
    if (counts.length === 0 || total <= 0) {
      last = `${source} shows no requests by instance`;
      continue;
    }
    const shares = Object.fromEntries(
      counts.map(([k, v]) => [k.replace(/^instance=/, ''), v / total]),
    );
    const ideal = 1 / n;
    const balanced =
      counts.length === n &&
      Object.values(shares).every((s) => Math.abs(s - ideal) <= SHARE_TOLERANCE * ideal);
    return ok({ source, shares, balanced });
  }
  return unmeasured(last);
}

export function scaleOutLine(opts: {
  n: number;
  servedRps: number | null;
  efficiency: number;
  baseline: Reading<{ dir: string; servedRps: number; verdict: string }> | null;
  routing: Reading<RoutingShares> | null;
}): Line {
  const base = {
    key: 'scaleOut.efficiency',
    name: 'scale-out',
    limit: `≥ ${opts.efficiency} × N × baseline`,
  };
  if (opts.n <= 1) return { ...base, status: 'n/a', value: 'N = 1', reason: null };
  if (!opts.baseline)
    return { ...base, status: 'unmeasured', value: 'unmeasured', reason: 'no baseline named' };
  if (opts.baseline.state !== 'ok')
    return { ...base, status: 'unmeasured', value: 'unmeasured', reason: opts.baseline.reason };
  if (!opts.routing || opts.routing.state !== 'ok')
    return {
      ...base,
      status: 'unmeasured',
      value: 'unmeasured',
      reason: `the per-instance request share is unreadable${opts.routing ? ` (${opts.routing.reason})` : ''}`,
    };
  const shares = Object.entries(opts.routing.value.shares)
    .map(([k, v]) => `${k} ${Math.round(v * 100)} %`)
    .join(', ');
  if (!opts.routing.value.balanced)
    return {
      ...base,
      status: 'unmeasured',
      value: `shares ${shares}`,
      reason: `routing, not scaling: a share is outside ±${SHARE_TOLERANCE * 100} % of 1/${opts.n}`,
    };
  if (opts.servedRps === null)
    return {
      ...base,
      status: 'unmeasured',
      value: 'unmeasured',
      reason: 'served rps is unmeasured',
    };
  const need = opts.efficiency * opts.n * opts.baseline.value.servedRps;
  return {
    ...base,
    limit: `≥ ${round2(need)} rps (${opts.efficiency} × ${opts.n} × ${round2(opts.baseline.value.servedRps)})`,
    status: opts.servedRps >= need - 1e-9 ? 'PASS' : 'FAIL',
    value: `${round2(opts.servedRps)} rps (shares ${shares})`,
    reason: null,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
