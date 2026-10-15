// proxy_shed — A READING, NOT A THRESHOLD (Story MOTIR-8538 · MOTIR-8679).
//
// Three numbers printed side by side, attributed to none of them and judged by
// nothing:
//   platform  per instance, the rise of Fly's proxy counter
//             `fly_app_http_responses_count{status="503"}` over the run window
//             (end minus start, absent = 0)
//   logs      captured log lines carrying the proxy's own error codes
//             (docs.fly.io/monitoring/error-codes): PL01 connection limit, PL02
//             request limit, PR01 "No healthy machines were found"
//   client    k6's `http_503` count from the reader scenarios
// Fly does not document what a client sees when a limit is hit, nor a header that
// marks a proxy-made response, so the client count never says WHO answered.
//
// ⚠️ HYPOTHESIS, checked on the first smoke run (which drives staging past its hard
// limit once on purpose): a request refused at the staging hard limit shows up as a
// 503 in `fly_app_http_responses_count`.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { ok, unmeasured, type Reading } from './inputs';
import { counterDelta, sel, widen, type PromClient } from './prometheus';

export const PROXY_CODES = ['PL01', 'PL02', 'PR01'] as const;
export type ProxyCode = (typeof PROXY_CODES)[number];

export interface ProxyShed {
  platform: Reading<Record<string, number | null>>;
  logCodes: Reading<Record<ProxyCode, number>>;
  client503: Reading<number>;
}

export async function readPlatform503(
  prom: PromClient,
  window: { start: number; end: number },
): Promise<Reading<Record<string, number | null>>> {
  const { start, end } = widen(window.start, window.end);
  const d = await counterDelta(
    prom,
    `sum by (instance, status) (fly_app_http_responses_count${sel(prom.app)})`,
    start,
    end,
    ['instance', 'status'],
  );
  if (d.state !== 'ok') return d;
  if (d.value.size === 0) {
    return unmeasured('no fly_app_http_responses_count series for this app');
  }
  const out: Record<string, number | null> = {};
  for (const [k, v] of d.value) {
    const instance = /instance=([^,]*)/.exec(k)?.[1] ?? 'unknown';
    // `in`, not `??=`: a null (its 503 counter went backwards) must survive a
    // later non-503 series for the same instance.
    const sofar = instance in out ? (out[instance] as number | null) : 0;
    out[instance] = /status=503\b/.test(k)
      ? v === null || sofar === null
        ? null
        : sofar + v
      : sofar;
  }
  return ok(out);
}

export async function countProxyCodes(
  appLogs: Reading<string>,
): Promise<Reading<Record<ProxyCode, number>>> {
  if (appLogs.state !== 'ok') return appLogs;
  const counts: Record<ProxyCode, number> = { PL01: 0, PL02: 0, PR01: 0 };
  const lines = createInterface({ input: createReadStream(appLogs.value), crlfDelay: Infinity });
  for await (const line of lines) {
    let message = line;
    try {
      message = String((JSON.parse(line) as Record<string, unknown>)['message'] ?? '');
    } catch {
      /* a raw line is searched as it is */
    }
    for (const code of PROXY_CODES)
      if (new RegExp(`\\b${code}\\b`).test(message)) counts[code] += 1;
  }
  return ok(counts);
}
