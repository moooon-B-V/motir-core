// THE N-MACHINE PIN LOOP (Story MOTIR-8538 · MOTIR-8678).
//
// Proves, from the app's own answers, that exactly the N recorded `app` machines
// are serving — before any load is sent:
//   1. the ENFORCEMENT probe: one request pinned (`fly-force-instance-id`) to a
//      machine that does not exist. If the app answers it, the proxy ignored the
//      pin and no later pinned answer can be attributed: refused.
//   2. one `GET /api/health/ready` pinned to EACH machine id, every one answering
//      200 with `{ "state": "ready" }`. A redirect is a failure, not a pass:
//      Flycast is HTTP-only, so a redirect means the request did not reach what
//      was asked.
//
// Fly documents `fly-force-instance-id` as forcing one machine with no fallback,
// but not the answer for an unknown id, nor whether the header applies to flycast
// traffic at all — the enforcement probe is that check, and its answer is recorded.
//
// ⚠️ Staging is private (flycast only), so every probe runs ON THE GENERATOR:
// `curl` through `fly ssh console --machine <generator> -C "sh -c '…'"`, never from
// the operator machine. `createPinnedClient` (scripts/staging) is two-machine only
// and is not used; its exported pieces are.

import { FORCE_INSTANCE_HEADER, NO_SUCH_MACHINE } from '../../scripts/staging/lib/pinnedClient';
import { sshArgs, shScript, type FlyRunner } from './fly';

export const READY_PATH = '/api/health/ready';

export interface ProbeAnswer {
  status: number;
  body: string;
}

/** One HTTP GET with headers; redirects are NOT followed. */
export type Probe = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<ProbeAnswer>;

/** A value safe to put inside a double-quoted word of a single-quoted `sh -c` script. */
const SAFE = /^[A-Za-z0-9._~:/?#[\]@!&()*+,;=%-]+$/;

/** The remote curl script for one probe (exported so tests read exactly what is sent). */
export function curlScript(url: string, headers: Readonly<Record<string, string>>): string {
  if (!SAFE.test(url)) throw new Error(`refusing to send an unsafe URL to the generator: ${url}`);
  const h = Object.entries(headers).map(([k, v]) => {
    if (!/^[A-Za-z0-9-]+$/.test(k) || !SAFE.test(v)) throw new Error(`unsafe header ${k}`);
    return `-H "${k}: ${v}"`;
  });
  // The body, then the status code on its own last line.
  return ['curl -sS --max-time 15', ...h, '-w "\\n%{http_code}"', `"${url}"`].join(' ');
}

/** Parse curl's output: everything but the last line is the body, the last line the status. */
export function parseCurl(stdout: string): ProbeAnswer {
  const text = stdout.replace(/\r/g, '').replace(/\n+$/, '');
  const cut = text.lastIndexOf('\n');
  const status = Number(cut === -1 ? text : text.slice(cut + 1));
  return {
    status: Number.isInteger(status) ? status : 0,
    body: cut === -1 ? '' : text.slice(0, cut),
  };
}

/** The production probe: curl on the generator through `fly ssh console`. */
export function generatorProbe(fly: FlyRunner, generatorApp: string, generatorId: string): Probe {
  return async (url, headers) => {
    const r = await fly(sshArgs(generatorApp, generatorId, shScript(curlScript(url, headers))));
    if (r.code !== 0) return { status: 0, body: '' };
    return parseCurl(r.stdout);
  };
}

function stateOf(body: string): string | null {
  try {
    const s = (JSON.parse(body) as { state?: unknown }).state;
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

export interface PinResult {
  /** True when the proxy did NOT let the app answer a bogus pin. */
  enforced: boolean;
  /** What answered the bogus pin, as `status <n>` (never a body). */
  unknownIdAnswer: string;
  /** Per machine id: ready, or why not. */
  machines: { id: string; ready: boolean; answer: string }[];
  /** All N answered ready and the pin is enforced. */
  ok: boolean;
  /** Why not, when not. */
  reason: string | null;
}

/** Run the enforcement probe, then one pinned readiness request per machine. */
export async function pinLoop(
  probe: Probe,
  baseUrl: string,
  ids: readonly string[],
): Promise<PinResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}${READY_PATH}`;
  const bogus = await probe(url, { [FORCE_INSTANCE_HEADER]: NO_SUCH_MACHINE });
  const answeredByApp = bogus.status >= 200 && bogus.status < 300 && stateOf(bogus.body) !== null;
  const unknownIdAnswer = bogus.status === 0 ? 'no answer' : `status ${bogus.status}`;
  if (answeredByApp) {
    return {
      enforced: false,
      unknownIdAnswer,
      machines: [],
      ok: false,
      reason:
        `the app answered a request pinned to ${NO_SUCH_MACHINE} (${unknownIdAnswer}): the proxy ` +
        'ignores fly-force-instance-id here, so no pinned answer can be trusted',
    };
  }
  const machines: PinResult['machines'] = [];
  for (const id of ids) {
    const a = await probe(url, { [FORCE_INSTANCE_HEADER]: id });
    const state = stateOf(a.body);
    const ready = a.status === 200 && state === 'ready';
    const answer =
      a.status >= 300 && a.status < 400
        ? `redirect ${a.status}`
        : a.status === 0
          ? 'no answer'
          : `status ${a.status}${state ? ` ${state}` : ''}`;
    machines.push({ id, ready, answer });
  }
  const notReady = machines.filter((m) => !m.ready);
  return {
    enforced: true,
    unknownIdAnswer,
    machines,
    ok: notReady.length === 0,
    reason:
      notReady.length === 0
        ? null
        : `not ready: ${notReady.map((m) => `${m.id} (${m.answer})`).join(', ')}`,
  };
}
