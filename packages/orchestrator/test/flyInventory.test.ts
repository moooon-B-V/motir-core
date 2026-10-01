import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  flyFleetInventory,
  flyInventoryConfig,
  isFlyInventoryConfigured,
} from '../src/index';

// The FLY FLEET INVENTORY on the wire (Story MOTIR-6906 · MOTIR-6925,
// `docs/decisions/fleet-per-org-pool.md` §5) — every app in the fleet
// organisation and every machine in each, against a stubbed Machines API. No
// database; `fetch` is the only fake.

interface Call {
  url: string;
  method: string;
  auth: string | null;
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const API = 'https://api.machines.dev/v1';

beforeEach(() => {
  calls = [];
  handler = () => json(500, { error: 'no handler' });
  vi.stubEnv('FLY_INVENTORY_API_TOKEN', 'org-token');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fleet-token');
  vi.stubEnv('FLY_FLEET_ORG', '');
  vi.stubEnv('FLY_INSTANCES_ORG', '');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      auth: headers['authorization'] ?? null,
    };
    calls.push(call);
    return handler(call);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('configuration', () => {
  it('prefers the org-scoped token and defaults the organisation to the fleet org', () => {
    expect(flyInventoryConfig()).toEqual({ token: 'org-token', org: 'motir-fleet' });
    expect(isFlyInventoryConfigured()).toBe(true);
  });

  it('falls back to the fleet token, and to the instances org', () => {
    vi.stubEnv('FLY_INVENTORY_API_TOKEN', '');
    vi.stubEnv('FLY_INSTANCES_ORG', 'motir-inst-org');
    expect(flyInventoryConfig()).toEqual({ token: 'fleet-token', org: 'motir-inst-org' });
    vi.stubEnv('FLY_FLEET_ORG', 'motir-fleet-2');
    expect(flyInventoryConfig().org).toBe('motir-fleet-2');
  });

  it('is not configured with neither token', () => {
    vi.stubEnv('FLY_INVENTORY_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    expect(isFlyInventoryConfigured()).toBe(false);
    expect(() => flyInventoryConfig()).toThrow(OrchestratorNotConfiguredError);
  });
});

describe('listApps', () => {
  it('lists every app in the organisation with the org-scoped token', async () => {
    handler = () =>
      json(200, {
        total_apps: 3,
        apps: [{ name: 'motir-ci-fleet' }, { name: 'motir-inst-1' }, {}],
      });
    expect(await flyFleetInventory.listApps()).toEqual(['motir-ci-fleet', 'motir-inst-1']);
    expect(calls).toEqual([
      { url: `${API}/apps?org_slug=motir-fleet`, method: 'GET', auth: 'Bearer org-token' },
    ]);
  });

  it('THROWS on a refusal — never an empty organisation', async () => {
    handler = () => json(503, { error: 'unavailable' });
    await expect(flyFleetInventory.listApps()).rejects.toBeInstanceOf(OrchestratorApiError);
  });

  it('THROWS on a body with no apps array', async () => {
    handler = () => json(200, { total_apps: 0 });
    await expect(flyFleetInventory.listApps()).rejects.toThrow(/no `apps` array/);
  });
});

describe('listMachines', () => {
  it('lists every machine, tagged or not, in the instance vocabulary', async () => {
    handler = () =>
      json(200, [
        {
          id: 'm-1',
          name: 'motir-runner-1',
          state: 'started',
          region: 'iad',
          created_at: '2026-09-28T10:00:00.000Z',
          config: { metadata: { motir_fleet: 'ci-runner' } },
        },
        { id: 'm-2', name: '', state: 'destroyed', region: 'ord' },
        { not: 'a machine' },
      ]);
    expect(await flyFleetInventory.listMachines('motir-ci-fleet')).toEqual([
      {
        app: 'motir-ci-fleet',
        machineId: 'm-1',
        name: 'motir-runner-1',
        region: 'iad',
        state: 'running',
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
        metadata: { motir_fleet: 'ci-runner' },
      },
      {
        app: 'motir-ci-fleet',
        machineId: 'm-2',
        name: '',
        region: 'ord',
        state: 'gone',
        createdAt: null,
        metadata: {},
      },
    ]);
    expect(calls[0]!.url).toBe(`${API}/apps/motir-ci-fleet/machines`);
  });

  it('an app deleted since the app list is empty', async () => {
    handler = () => json(404, { error: 'not found' });
    expect(await flyFleetInventory.listMachines('gone-app')).toEqual([]);
  });

  it('a non-array body is empty, and a refusal THROWS', async () => {
    handler = () => json(200, { weird: true });
    expect(await flyFleetInventory.listMachines('a')).toEqual([]);
    handler = () => json(500, { error: 'boom' });
    await expect(flyFleetInventory.listMachines('a')).rejects.toBeInstanceOf(OrchestratorApiError);
  });
});

describe('destroyMachine', () => {
  it('force-destroys, and a machine already gone is the end state', async () => {
    handler = () => json(200, { ok: true });
    await flyFleetInventory.destroyMachine('app-1', 'm-1');
    expect(calls[0]).toEqual({
      url: `${API}/apps/app-1/machines/m-1?force=true`,
      method: 'DELETE',
      auth: 'Bearer org-token',
    });
    handler = () => json(404, { error: 'not found' });
    await flyFleetInventory.destroyMachine('app-1', 'm-1');
  });

  it('throws on any other refusal', async () => {
    handler = () => json(409, { error: 'locked' });
    await expect(flyFleetInventory.destroyMachine('app-1', 'm-1')).rejects.toThrow(/locked/);
  });
});

describe('stopMachine', () => {
  it('stops, and a machine that is gone is the end state', async () => {
    handler = () => json(200, { ok: true });
    await flyFleetInventory.stopMachine('app-1', 'm-1');
    expect(calls[0]).toEqual({
      url: `${API}/apps/app-1/machines/m-1/stop`,
      method: 'POST',
      auth: 'Bearer org-token',
    });
    handler = () => json(404, { error: 'not found' });
    await flyFleetInventory.stopMachine('app-1', 'm-1');
  });

  it('a refusal on a machine already stopped, or gone by the re-read, is the end state', async () => {
    handler = (call) =>
      call.method === 'POST'
        ? json(412, { error: 'machine not in a stoppable state' })
        : json(200, { id: 'm-1', state: 'stopped' });
    await flyFleetInventory.stopMachine('app-1', 'm-1');
    handler = (call) =>
      call.method === 'POST' ? json(412, { error: 'nope' }) : json(404, { error: 'gone' });
    await flyFleetInventory.stopMachine('app-1', 'm-1');
    handler = (call) => (call.method === 'POST' ? json(412, { error: 'nope' }) : json(200, {}));
    await flyFleetInventory.stopMachine('app-1', 'm-1');
  });

  it('a refusal on a machine still running THROWS the refusal', async () => {
    handler = (call) =>
      call.method === 'POST'
        ? json(412, { error: 'host unreachable' })
        : json(200, { id: 'm-1', state: 'started' });
    await expect(flyFleetInventory.stopMachine('app-1', 'm-1')).rejects.toThrow(/host unreachable/);
    handler = (call) =>
      call.method === 'POST' ? json(500, { error: 'boom' }) : json(500, { error: 'read failed' });
    await expect(flyFleetInventory.stopMachine('app-1', 'm-1')).rejects.toThrow(/boom/);
  });
});
