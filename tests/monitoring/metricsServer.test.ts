import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  METRICS_PATH,
  startMetricsServer,
  stopMetricsServerForTests,
} from '@/lib/monitoring/metricsServer';
import {
  recordTransactionMeasurement,
  REQUEST_DB_TIMING_METRICS,
  resetRequestDbTimingForTests,
} from '@/lib/monitoring/requestDbTiming';

// MOTIR-8553 — the private metrics port: absent unless configured, the
// registry's exposition on GET /metrics, 404 elsewhere, once per process.

beforeEach(async () => {
  await stopMetricsServerForTests();
  resetRequestDbTimingForTests();
});

afterEach(async () => {
  await stopMetricsServerForTests();
  resetRequestDbTimingForTests();
});

/** Port 0 is refused by the parser, so pick a free port by listening first. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function listening(server: NonNullable<ReturnType<typeof startMetricsServer>>) {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}

describe('startMetricsServer', () => {
  it('opens no port when MONITORING_METRICS_PORT is unset or blank', () => {
    expect(startMetricsServer({})).toBeNull();
    expect(startMetricsServer({ MONITORING_METRICS_PORT: '  ' })).toBeNull();
  });

  it('opens no port for a value that is not a port', () => {
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => warned.push(args[0]);
    try {
      expect(startMetricsServer({ MONITORING_METRICS_PORT: 'ninety' })).toBeNull();
      expect(startMetricsServer({ MONITORING_METRICS_PORT: '70000' })).toBeNull();
    } finally {
      console.warn = warn;
    }
    expect(warned).toHaveLength(2);
  });

  it('serves the exposition on GET /metrics, 404 elsewhere, and starts once', async () => {
    recordTransactionMeasurement({
      context: 'workspace',
      attempt: 1,
      waitMs: 3,
      holdMs: 7,
      outcome: 'committed',
      pool: 'unmeasured',
    });
    const env = { MONITORING_METRICS_PORT: String(await freePort()) };
    const server = startMetricsServer(env);
    expect(server).not.toBeNull();
    expect(startMetricsServer(env)).toBe(server);
    const port = await listening(server!);

    const ok = await fetch(`http://127.0.0.1:${port}${METRICS_PATH}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/plain/);
    const body = await ok.text();
    expect(body).toContain(`# TYPE ${REQUEST_DB_TIMING_METRICS.wait} histogram`);
    expect(body).toMatch(/db_tx_wait_seconds_count\{[^}]*route="unlabelled"[^}]*\} 1/);

    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/metrics/x`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}${METRICS_PATH}`, { method: 'POST' })).status,
    ).toBe(404);
  });
});

describe('instrumentation.ts — Node only', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'instrumentation.ts'), 'utf8');

  it('imports the recorder and the metrics server dynamically, below the nodejs gate', () => {
    const gate = source.indexOf("if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;");
    expect(gate).toBeGreaterThan(-1);
    for (const mod of ['@/lib/monitoring/requestDbTiming', '@/lib/monitoring/metricsServer']) {
      const at = source.indexOf(`await import('${mod}')`);
      expect(at, mod).toBeGreaterThan(gate);
      expect(source, mod).not.toMatch(new RegExp(`^import[^\\n]*'${mod}'`, 'm'));
    }
    expect(source).not.toMatch(/^import[^\n]*(prom-client|node:http)/m);
  });
});
