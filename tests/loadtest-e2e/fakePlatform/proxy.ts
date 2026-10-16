// THE FAKE FLY PROXY (Story MOTIR-8538 · MOTIR-8682) — the run's base URL.
//
// Staging is reached through Fly's proxy, which spreads requests over the app's
// STARTED machines and honours `fly-force-instance-id` ("forces routing to a
// specific Machine", Fly's dynamic request routing docs). This stand-in does the
// same over the lane's two `next start` instances:
//
//   · no pin   → round-robin across the `app` machines the fake platform reports
//                as started (read from state.json on each request, so `fly scale
//                count` and `fly machine stop` change the routing exactly as they
//                change the platform's answer). At N = 1 only the first serves.
//   · a pin to a started machine → that machine, no fallback.
//   · a pin to any other id (`NO_SUCH_MACHINE` from scripts/staging/lib/pinnedClient.ts,
//     or a stopped machine) → REFUSED with a 503 and a non-JSON body. Fly does not
//     document the status an unknown id gets; the run command's enforcement probe
//     must not depend on which, and only needs the app NOT to answer it.
//
// Every response it relays is counted by (machine, status) with its time, which is
// what the stub Prometheus serves as `fly_app_http_responses_count` — the proxy's
// own per-instance response counter, as on Fly. Every pinned request is appended to
// `pins.ndjson` so a case can show the readiness checks reached it.

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, Agent, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FORCE_INSTANCE_HEADER = 'fly-force-instance-id';

/** Cumulative response counts by machine and status, each event with its epoch ms. */
export class ResponseCounts {
  private readonly events = new Map<string, number[]>();

  record(machine: string, status: number, atMs: number): void {
    const k = `${machine}\u0000${status}`;
    const list = this.events.get(k) ?? [];
    list.push(atMs);
    this.events.set(k, list);
  }

  /** Every (machine, status) pair seen so far. */
  keys(): { machine: string; status: string }[] {
    return [...this.events.keys()].map((k) => {
      const [machine, status] = k.split('\u0000') as [string, string];
      return { machine, status };
    });
  }

  /** The counter's value at `atMs`: the responses relayed at or before it. */
  valueAt(machine: string, status: string, atMs: number): number {
    const list = this.events.get(`${machine}\u0000${status}`) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! <= atMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

interface ProxyState {
  stagingApp: string;
  origins: Record<string, string>;
  apps: Record<
    string,
    { machines: { id: string; group: string; state: string; exists?: boolean }[] }
  >;
}

export interface FakeProxy {
  origin: string;
  counts: ResponseCounts;
  close(): Promise<void>;
}

/** The started `app` machines of the staging app that have an instance behind them, in id order. */
export function startedTargets(state: ProxyState): { id: string; origin: string }[] {
  const app = state.apps[state.stagingApp];
  return (app?.machines ?? [])
    .filter((m) => m.group === 'app' && m.exists !== false && m.state === 'started')
    .filter((m) => state.origins[m.id])
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, origin: state.origins[m.id]! }));
}

export async function startProxy(opts: { statePath: string; pinsLog: string }): Promise<FakeProxy> {
  const counts = new ResponseCounts();
  const agent = new Agent({ keepAlive: true, maxSockets: 256 });
  let turn = 0;
  let cached: { at: number; state: ProxyState } | null = null;
  const state = (): ProxyState => {
    const now = Date.now();
    if (!cached || now - cached.at > 200) {
      cached = { at: now, state: JSON.parse(readFileSync(opts.statePath, 'utf8')) as ProxyState };
    }
    return cached.state;
  };

  const server: Server = createServer((req, res) => {
    const targets = startedTargets(state());
    const pinned = req.headers[FORCE_INSTANCE_HEADER];
    const pin = Array.isArray(pinned) ? pinned[0] : pinned;
    let target: { id: string; origin: string } | undefined;
    if (pin !== undefined) {
      target = targets.find((t) => t.id === pin);
      appendFileSync(
        opts.pinsLog,
        `${JSON.stringify({ at: new Date().toISOString(), pin, path: req.url, routed: Boolean(target) })}\n`,
      );
      if (!target) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end(`fake fly proxy: no started machine ${pin}\n`);
        return;
      }
    } else {
      if (targets.length === 0) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('fake fly proxy: no started machines\n');
        return;
      }
      target = targets[turn++ % targets.length]!;
    }
    const chosen = target;
    const up = new URL(chosen.origin);
    const headers = { ...req.headers };
    delete headers[FORCE_INSTANCE_HEADER];
    const upstream = httpRequest(
      {
        host: up.hostname,
        port: up.port,
        method: req.method,
        path: req.url,
        headers,
        agent,
      },
      (answer) => {
        counts.record(chosen.id, answer.statusCode ?? 0, Date.now());
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        res.flushHeaders();
        answer.pipe(res);
        answer.on('error', () => res.destroy());
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        counts.record(chosen.id, 502, Date.now());
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('fake fly proxy: the instance did not answer\n');
      } else res.destroy();
    });
    // A client that hangs up (a held stream ending) takes the upstream request with it.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    counts,
    close: () =>
      new Promise<void>((r) => {
        agent.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
