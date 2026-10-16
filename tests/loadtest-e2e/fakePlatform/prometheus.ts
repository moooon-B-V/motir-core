// THE STUB PROMETHEUS AND NEON API (Story MOTIR-8538 · MOTIR-8682).
//
// One localhost HTTP server standing in for the two platform APIs the run cannot
// reach in CI. Both check their `Authorization: Bearer` header and record every
// request (method, path, query — never the header) to `requests.ndjson`.
//
// ── PROMETHEUS — `${base}/prometheus/moooon/api/v1/{query,query_range}` ──────
// The report's `LOADTEST_PROM_URL` points here. It answers the series names the
// report queries (loadtest/report/{p2028,proxyShed,scaleOut,bottleneck}.ts) with
// FLAT, UNSATURATED values, one series per started staging `app` machine — the
// `instance` label being the machine id, as on Fly:
//   db_tx_wait_seconds_count{outcome=~"p2028_.*"}   0 on every instance
//   db_tx_wait_seconds_count{outcome="committed"}  rising on every instance (the positive control)
//   db_tx_wait_seconds_count (by instance)         rising, split evenly
//   fly_app_http_responses_count                   the fake proxy's OWN per-instance
//                                                  response counts by status, with a
//                                                  `status="503"` series on every
//                                                  instance (0 unless the proxy relayed one)
//   fly_app_concurrency, fly_instance_cpu{mode}, fly_instance_cpu_throttle,
//   fly_instance_memory_mem_{available,total}, the pool-wait ratio and the
//   wait/hold histogram quantiles                  flat, far from any limit
// Anything else answers an empty `success`. A counter is a value AT a time, so the
// report's end-minus-start reads see the rise over its window.
//
// ── NEON — `${base}/neon/api/v2/projects/{project}/branches/{branch}/…` ──────
// The capture's `LOADTEST_NEON_API_URL` points here:
//   GET  …/endpoints                              the endpoint-state read
//   POST …/roles/{role}/reset_password            `role.password` and `operations[]`,
//                                                 so the runbook's rotation call is covered

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startedTargets, type ResponseCounts } from './proxy';

export const PROM_PREFIX = '/prometheus/moooon';
export const NEON_PREFIX = '/neon/api/v2';

type Sample = [number, string];
interface Result {
  metric: Record<string, string>;
  value?: Sample;
  values?: Sample[];
}

export interface StubOptions {
  statePath: string;
  requestsLog: string;
  promToken: string;
  neonKey: string;
  neon: { projectId: string; branchId: string; endpointId: string; roleName: string };
  counts: ResponseCounts;
}

export interface Stub {
  origin: string;
  promUrl: string;
  neonUrl: string;
  close(): Promise<void>;
}

/** When every synthetic counter started, in epoch seconds: well before any run. */
const T0 = Math.floor(Date.now() / 1000) - 3600;
const rising = (perSecond: number) => (t: number) => perSecond * Math.max(0, t - T0);
const flat = (v: number) => () => v;

const ROUTES = ['mcp', 'api_v1_dispatch_runs', 'workbench', 'items', 'plans'];
const TOOLS = ['get_work_item', 'search_work_items', 'update_work_item', 'claim_work_item'];

function seriesFor(
  query: string,
  ids: string[],
  counts: ResponseCounts,
): { labels: Record<string, string>; at: (t: number) => number }[] {
  const per = (labels: (id: string) => Record<string, string>, at: (t: number) => number) =>
    ids.map((id) => ({ labels: { instance: id, ...labels(id) }, at }));

  if (query.includes('db_tx_wait_seconds_count')) {
    if (query.includes('outcome=~"p2028_.*"')) {
      return [
        ...per(() => ({ outcome: 'p2028_wait' }), flat(0)),
        ...per(() => ({ outcome: 'p2028_timeout' }), flat(0)),
      ];
    }
    if (query.includes('outcome="committed"')) return per(() => ({}), rising(3));
    return per(() => ({}), rising(4));
  }
  if (query.includes('fly_app_http_responses_count')) {
    const byStatus = /by \(instance, status\)/.test(query);
    const out: { labels: Record<string, string>; at: (t: number) => number }[] = [];
    const pairs = counts.keys().filter((k) => ids.includes(k.machine));
    if (byStatus) {
      for (const k of pairs)
        out.push({
          labels: { instance: k.machine, status: k.status },
          at: (t) => counts.valueAt(k.machine, k.status, t * 1000),
        });
      for (const id of ids)
        if (!pairs.some((k) => k.machine === id && k.status === '503'))
          out.push({ labels: { instance: id, status: '503' }, at: flat(0) });
      return out;
    }
    for (const id of ids) {
      const mine = pairs.filter((k) => k.machine === id);
      if (mine.length === 0) continue;
      out.push({
        labels: { instance: id },
        at: (t) => mine.reduce((a, k) => a + counts.valueAt(id, k.status, t * 1000), 0),
      });
    }
    return out;
  }
  if (query.includes('fly_app_concurrency')) return per(() => ({}), flat(2));
  if (query.includes('fly_instance_cpu_throttle')) return per(() => ({}), flat(0));
  if (query.includes('fly_instance_cpu')) {
    // Centiseconds per second, on a 2-CPU machine: 0.25 CPU busy.
    const modes: Record<string, number> = { user: 20, system: 5, idle: 175, iowait: 0, steal: 0 };
    return Object.entries(modes).flatMap(([mode, rate]) => per(() => ({ mode }), rising(rate)));
  }
  if (query.includes('fly_instance_memory_mem_available')) return per(() => ({}), flat(3e9));
  if (query.includes('fly_instance_memory_mem_total')) return per(() => ({}), flat(4.096e9));
  if (query.includes('db_pool_waiting_at_acquire')) return [{ labels: {}, at: flat(0) }];
  if (query.includes('histogram_quantile')) {
    const by = /sum by \(le, (route|tool)\)/.exec(query)?.[1];
    const v = query.includes('_hold_') ? 0.012 : 0.004;
    if (by === 'route') return ROUTES.map((route) => ({ labels: { route }, at: flat(v) }));
    if (by === 'tool') return TOOLS.map((tool) => ({ labels: { tool }, at: flat(v) }));
    return [{ labels: {}, at: flat(v) }];
  }
  return [];
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text;
}

export async function startStub(opts: StubOptions): Promise<Stub> {
  const startedIds = (): string[] => {
    const state = JSON.parse(readFileSync(opts.statePath, 'utf8'));
    return startedTargets(state).map((t) => t.id);
  };
  const record = (entry: Record<string, unknown>) =>
    appendFileSync(
      opts.requestsLog,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const auth = req.headers['authorization'] ?? '';
      if (url.pathname.startsWith(PROM_PREFIX)) {
        const params = url.pathname.endsWith('/api/v1/query') ? url.searchParams : null;
        const range = url.pathname.endsWith('/api/v1/query_range') ? url.searchParams : null;
        const query = (params ?? range)?.get('query') ?? '';
        const authorized = auth === `Bearer ${opts.promToken}`;
        record({ api: 'prometheus', method: req.method, path: url.pathname, query, authorized });
        if (!authorized) return json(res, 401, { status: 'error', error: 'unauthorized' });
        if (!params && !range) return json(res, 404, { status: 'error', error: 'not found' });
        const series = seriesFor(query, startedIds(), opts.counts);
        let result: Result[];
        if (params) {
          const t = Number(params.get('time') ?? Date.now() / 1000);
          result = series.map((s) => ({ metric: s.labels, value: [t, String(s.at(t))] }));
        } else {
          const start = Number(range!.get('start'));
          const end = Number(range!.get('end'));
          const step = Math.max(1, Number(range!.get('step') ?? 15));
          result = series.map((s) => {
            const values: Sample[] = [];
            for (let t = start; t <= end; t += step) values.push([t, String(s.at(t))]);
            return { metric: s.labels, values };
          });
        }
        return json(res, 200, {
          status: 'success',
          data: { resultType: params ? 'vector' : 'matrix', result },
        });
      }
      if (url.pathname.startsWith(NEON_PREFIX)) {
        const authorized = auth === `Bearer ${opts.neonKey}`;
        record({ api: 'neon', method: req.method, path: url.pathname, authorized });
        if (!authorized) return json(res, 401, { message: 'authorization failed', code: '' });
        const rest = url.pathname.slice(NEON_PREFIX.length);
        const m =
          /^\/projects\/([^/]+)\/branches\/([^/]+)\/(endpoints|roles\/([^/]+)\/reset_password)$/.exec(
            rest,
          );
        const { projectId, branchId, endpointId, roleName } = opts.neon;
        if (!m || m[1] !== projectId || m[2] !== branchId) {
          return json(res, 404, { message: 'not found', code: '' });
        }
        const now = new Date().toISOString();
        if (m[3] === 'endpoints' && req.method === 'GET') {
          return json(res, 200, {
            endpoints: [
              {
                id: endpointId,
                project_id: projectId,
                branch_id: branchId,
                type: 'read_write',
                current_state: 'active',
                autoscaling_limit_min_cu: 0.25,
                autoscaling_limit_max_cu: 2,
                pooler_enabled: true,
                pooler_mode: 'transaction',
                created_at: '2026-10-01T00:00:00Z',
                updated_at: now,
              },
            ],
          });
        }
        if (m[4] && req.method === 'POST') {
          await body(req);
          if (m[4] !== roleName) return json(res, 404, { message: 'role not found', code: '' });
          return json(res, 200, {
            role: {
              branch_id: branchId,
              name: roleName,
              password: 'npg_stubRotatedPassword0',
              protected: false,
              created_at: '2026-10-01T00:00:00Z',
              updated_at: now,
            },
            operations: [
              {
                id: '00000000-0000-4000-8000-000000000001',
                project_id: projectId,
                branch_id: branchId,
                endpoint_id: endpointId,
                action: 'apply_config',
                status: 'running',
                failures_count: 0,
                created_at: now,
                updated_at: now,
                total_duration_ms: 0,
              },
            ],
          });
        }
        return json(res, 405, { message: 'method not allowed', code: '' });
      }
      return json(res, 404, { message: 'not found' });
    })().catch((err: unknown) => json(res, 500, { status: 'error', error: String(err) }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    promUrl: `${origin}${PROM_PREFIX}`,
    neonUrl: `${origin}${NEON_PREFIX}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
