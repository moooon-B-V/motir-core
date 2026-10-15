import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  METRICS_PATH,
  startMetricsServer,
  stopMetricsServerForTests,
} from '@/lib/monitoring/metricsServer';
import {
  requestDbTimingRegistry,
  resetRequestDbTimingForTests,
} from '@/lib/monitoring/requestDbTiming';

// MOTIR-8556 — the metrics port's two failure arms, which a scrape must survive
// without taking the web server with it: the registry failing to render, and the
// port failing to bind.

let squatter: Server | null = null;

beforeEach(async () => {
  await stopMetricsServerForTests();
  resetRequestDbTimingForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopMetricsServerForTests();
  resetRequestDbTimingForTests();
  if (squatter) await new Promise((resolve) => squatter!.close(resolve));
  squatter = null;
});

/** A port something else is already listening on. */
async function takenPort(): Promise<number> {
  squatter = createServer();
  await new Promise<void>((resolve) => squatter!.listen(0, resolve));
  return (squatter.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe('the metrics port when something fails', () => {
  it('a registry that fails to render answers 500 and logs, and the next scrape still answers', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = startMetricsServer({ MONITORING_METRICS_PORT: String(await freePort()) })!;
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    vi.spyOn(requestDbTimingRegistry(), 'metrics').mockRejectedValueOnce(new Error('render broke'));
    const failed = await fetch(`http://127.0.0.1:${port}${METRICS_PATH}`);
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('error\n');
    expect(logged.mock.calls.some((c) => String(c[0]).includes('[metricsServer]'))).toBe(true);

    expect((await fetch(`http://127.0.0.1:${port}${METRICS_PATH}`)).status).toBe(200);
  });

  it('a port already in use is logged, not thrown', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const port = await takenPort();
    const server = startMetricsServer({ MONITORING_METRICS_PORT: String(port) })!;
    expect(server).not.toBeNull();
    await new Promise((resolve) => server.once('error', resolve));
    expect(
      logged.mock.calls.some((c) => String(c[0]).includes(`metrics port ${port} failed`)),
    ).toBe(true);
  });

  it('stopping when nothing was started is a no-op', async () => {
    await expect(stopMetricsServerForTests()).resolves.toBeUndefined();
  });
});
