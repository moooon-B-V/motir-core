import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKBENCH_STREAM_FRAME as APP_STREAM_FRAME,
  WORKBENCH_STREAM_COALESCE_MS as APP_STREAM_COALESCE_MS,
} from '@/app/api/workbench/stream/route';
import { CLI_CLIENT_ID as APP_CLI_CLIENT_ID } from '@/lib/cliDevice/constants';
import {
  CLI_CLIENT_ID,
  WORKBENCH_STREAM_FRAME,
  WORKBENCH_STREAM_COALESCE_MS,
} from '@/scripts/staging/lib/cases';
import {
  AttributionError,
  attributePair,
  createPinnedClient,
  FORCE_INSTANCE_HEADER,
  NO_SUCH_MACHINE,
  StagingConfigError,
  type Served,
} from '@/scripts/staging/lib/pinnedClient';
import { EXIT, runTwoMachineCheck } from '@/scripts/staging/two-machine-check';

// The staging two-machine script's client, against a local HTTP stub standing in
// for Fly's proxy (Story MOTIR-8547 · MOTIR-8620). The script itself only runs
// against a deployed app; what is checkable here is that it pins every request,
// refuses a bad configuration before sending anything, and never attributes a
// response it cannot tie to a machine.

interface Stub {
  readonly url: string;
  readonly seen: Array<{ path: string; pin: string | undefined }>;
}

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/**
 * A stub proxy. `machines` are the ids it routes; a pin naming anything else is
 * answered 502 when `enforce` is set (Fly's behaviour), or by "the app" when not.
 */
async function stub(opts: {
  machines: string[];
  enforce: boolean;
  header?: (pin: string) => string;
}): Promise<Stub> {
  const seen: Stub['seen'] = [];
  server = createServer((req: IncomingMessage, res) => {
    const pin = req.headers[FORCE_INSTANCE_HEADER] as string | undefined;
    seen.push({ path: req.url ?? '', pin });
    if (opts.enforce && (!pin || !opts.machines.includes(pin))) {
      res.writeHead(502).end('no such instance');
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.header && pin) headers['fly-machine-id'] = opts.header(pin);
    res.writeHead(200, headers).end(JSON.stringify({ state: 'ready' }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

const env = (url: string, over: Record<string, string | undefined> = {}) => ({
  STAGING_BASE_URL: url,
  STAGING_ALLOWED_HOST: '127.0.0.1',
  STAGING_MACHINE_A: 'machine-a',
  STAGING_MACHINE_B: 'machine-b',
  STAGING_USER_EMAIL: 'check@example.com',
  STAGING_USER_PASSWORD: 'pw',
  STAGING_PAT: 'pat',
  STAGING_PROJECT_KEY: 'CHK',
  ...over,
});

describe('the pinned client', () => {
  it('pins A and B to their own machine ids, and attributes once the pin is shown to be enforced', async () => {
    const s = await stub({ machines: ['machine-a', 'machine-b'], enforce: true });
    const client = createPinnedClient({
      baseUrl: s.url,
      allowedHost: '127.0.0.1',
      machineA: 'machine-a',
      machineB: 'machine-b',
    });
    const before = await client.sendTo('A', '/api/health/ready');
    expect(before.machineId).toBeNull();
    expect(await client.probePinEnforcement()).toBe(true);
    const a = await client.sendTo('A', '/api/health/ready');
    const b = await client.sendTo('B', '/api/health/ready');
    expect(s.seen.map((x) => x.pin)).toEqual([
      'machine-a',
      NO_SUCH_MACHINE,
      'machine-a',
      'machine-b',
    ]);
    expect([a.attribution, a.machineId, b.machineId]).toEqual([
      'pin-enforced',
      'machine-a',
      'machine-b',
    ]);
    expect(attributePair(a, b)).toEqual({ first: 'machine-a', second: 'machine-b' });
  });

  it('reads a machine-id response header first, and fails when it names another machine', async () => {
    const honest = await stub({
      machines: ['machine-a', 'machine-b'],
      enforce: false,
      header: (pin) => pin,
    });
    const client = createPinnedClient({
      baseUrl: honest.url,
      allowedHost: '127.0.0.1',
      machineA: 'machine-a',
      machineB: 'machine-b',
    });
    const a = await client.sendTo('A', '/x');
    expect([a.attribution, a.machineId]).toEqual(['response-header', 'machine-a']);
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const liar = await stub({
      machines: ['machine-a', 'machine-b'],
      enforce: false,
      header: () => 'machine-c',
    });
    const lied = createPinnedClient({
      baseUrl: liar.url,
      allowedHost: '127.0.0.1',
      machineA: 'machine-a',
      machineB: 'machine-b',
    });
    await expect(lied.sendTo('B', '/x')).rejects.toThrow(/served by machine-c/);
  });

  it('detects a proxy that ignores the pin, and then never attributes', async () => {
    const s = await stub({ machines: ['machine-a', 'machine-b'], enforce: false });
    const client = createPinnedClient({
      baseUrl: s.url,
      allowedHost: '127.0.0.1',
      machineA: 'machine-a',
      machineB: 'machine-b',
    });
    expect(await client.probePinEnforcement()).toBe(false);
    const a = await client.sendTo('A', '/x');
    const b = await client.sendTo('B', '/x');
    expect(() => attributePair(a, b)).toThrow(/cannot attribute the response to a machine/);
  });

  it('refuses two responses from the same machine', () => {
    const served = (machineId: string) => ({ machineId }) as Served;
    expect(() => attributePair(served('m1'), served('m1'))).toThrow(AttributionError);
    expect(() => attributePair(served('m1'), served('m1'))).toThrow(
      /both requests were served by m1/,
    );
  });

  it.each([
    ['identical machine ids', { STAGING_MACHINE_B: 'machine-a' }, /same machine/],
    ['a missing machine id', { STAGING_MACHINE_B: undefined }, /must both be set/],
    [
      'an unset allowed host',
      { STAGING_ALLOWED_HOST: undefined },
      /STAGING_ALLOWED_HOST is not set/,
    ],
    [
      'a host that is not the allowed one',
      { STAGING_ALLOWED_HOST: 'staging.motir.co' },
      /Refusing/,
    ],
    ['a missing credential', { STAGING_PAT: undefined }, /STAGING_PAT/],
  ])('refuses %s with exit 2, before sending any request', async (_name, over, message) => {
    const s = await stub({ machines: ['machine-a', 'machine-b'], enforce: true });
    const outcome = await runTwoMachineCheck(env(s.url, over), []);
    expect(outcome.exitCode).toBe(EXIT.config);
    expect(outcome.message).toMatch(message);
    expect(s.seen).toEqual([]);
  });

  it('refuses an unparseable base URL', () => {
    expect(() =>
      createPinnedClient({ baseUrl: 'not a url', allowedHost: 'x', machineA: 'a', machineB: 'b' }),
    ).toThrow(StagingConfigError);
  });

  it('stops with exit 4 when the proxy does not enforce the pin', async () => {
    const s = await stub({ machines: ['machine-a', 'machine-b'], enforce: false });
    const outcome = await runTwoMachineCheck(env(s.url), []);
    expect(outcome.exitCode).toBe(EXIT.fleet);
    expect(outcome.message).toMatch(/not enforced/);
    expect(outcome.results).toEqual([]);
  });

  it('stops with exit 4 when a machine is not ready', async () => {
    const s = await stub({ machines: ['machine-a'], enforce: true });
    const outcome = await runTwoMachineCheck(env(s.url), []);
    expect(outcome.exitCode).toBe(EXIT.fleet);
    expect(outcome.message).toMatch(/machine B \(machine-b\) is not ready: 502/);
  });
});

describe('the constants the staging cases copy from the app', () => {
  it('match the app’s own values', () => {
    expect(WORKBENCH_STREAM_COALESCE_MS).toBe(APP_STREAM_COALESCE_MS);
    expect(WORKBENCH_STREAM_FRAME).toBe(APP_STREAM_FRAME);
    expect(CLI_CLIENT_ID).toBe(APP_CLI_CLIENT_ID);
  });
});
