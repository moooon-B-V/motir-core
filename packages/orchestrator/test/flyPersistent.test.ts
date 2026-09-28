import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  INSTANCE_METADATA_KEY,
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  VOLUME_RELEASE_ATTEMPTS,
  currentRunInstants,
  flyInstancesConfig,
  flyOrchestrator,
  flyPersistentOrchestrator,
  instanceAppName,
  instanceMachineName,
  instanceVolumeName,
  isFlyInstancesConfigured,
  persistentTiming,
  toFlyMachine,
  toPersistentState,
  type PersistentContainerHandle,
  type PersistentContainerSpec,
} from '../src/index';

// The FLY adapter's PERSISTENT half on the wire (Story MOTIR-6860 · MOTIR-6869,
// `docs/decisions/agent-instances.md` §1–§3, §7) — what each operation turns into
// on `api.machines.dev`, against a stubbed Machines API. No database; `fetch` is
// the only fake.

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
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
const ORG = 'org_cm1';
const APP = instanceAppName('motir-inst', ORG);

const SPEC: PersistentContainerSpec = {
  orgId: ORG,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  instanceId: 'cmInstance1',
  image: 'ghcr.io/moooon-b-v/motir-sandbox@sha256:' + 'b'.repeat(64),
  size: FLEET_CONTAINER_SIZE,
  env: { MOTIR_INSTANCE_ID: 'cmInstance1' },
  region: 'iad',
  volumeSizeGb: 10,
  mountPath: '/home/node',
};

const HANDLE: PersistentContainerHandle = {
  provider: 'fly',
  app: APP,
  machineId: 'm-1',
  volumeId: 'vol_1',
  region: 'iad',
  createdAt: new Date('2026-09-28T10:00:00.000Z'),
};

function flyMachine(
  state: string,
  events: Array<Record<string, unknown>> = [],
  metadata: Record<string, string> = {},
) {
  return {
    id: 'm-1',
    name: 'instance-cminstance1',
    state,
    region: 'iad',
    created_at: '2026-09-28T10:00:00.000Z',
    config: { metadata },
    events,
  };
}

beforeEach(() => {
  calls = [];
  handler = () => json(500, { error: 'no handler' });
  vi.stubEnv('FLY_INSTANCES_API_TOKEN', 'instances-token');
  vi.stubEnv('FLY_INSTANCES_REGION', '');
  vi.stubEnv('FLY_INSTANCES_APP_PREFIX', '');
  vi.stubEnv('FLY_INSTANCES_ORG', '');
  // The fleet's variables are set to values the instance lane must NEVER use.
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fleet-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'registry.fly.io/runner@sha256:abc');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      auth: headers['authorization'] ?? null,
    };
    calls.push(call);
    return handler(call);
  });
  persistentTiming.sleep = async () => {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the instance lane configuration (§7)', () => {
  it('reads only FLY_INSTANCES_*, with the decision’s defaults', () => {
    expect(flyInstancesConfig()).toEqual({
      token: 'instances-token',
      region: 'iad',
      appPrefix: 'motir-inst',
      org: 'motir-fleet',
    });
    vi.stubEnv('FLY_INSTANCES_REGION', 'ams');
    vi.stubEnv('FLY_INSTANCES_APP_PREFIX', 'inst');
    vi.stubEnv('FLY_INSTANCES_ORG', 'other-org');
    expect(flyInstancesConfig()).toMatchObject({
      region: 'ams',
      appPrefix: 'inst',
      org: 'other-org',
    });
  });

  it('is not configured without its own token, even when the fleet is', () => {
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', '');
    expect(isFlyInstancesConfigured()).toBe(false);
    expect(() => flyInstancesConfig()).toThrow(OrchestratorNotConfiguredError);
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', 'x');
    expect(isFlyInstancesConfigured()).toBe(true);
  });

  it('names one app per organisation, deterministically, and a volume Fly accepts', () => {
    expect(APP).toMatch(/^motir-inst-[0-9a-f]{16}$/);
    expect(instanceAppName('motir-inst', ORG)).toBe(APP);
    expect(instanceAppName('motir-inst', 'org_other')).not.toBe(APP);
    expect(flyPersistentOrchestrator.appNameFor(ORG)).toBe(APP);
    const volume = instanceVolumeName('cmInstance1');
    expect(volume).toMatch(/^[a-z0-9_]{1,30}$/);
    expect(instanceMachineName('cmInstance_1')).toBe('instance-cminstance-1');
  });
});

describe('provisionPersistent', () => {
  it('ensures the org app with its own network, creates a volume, then a machine MOUNTING it — auto_destroy false', async () => {
    handler = (call) => {
      if (call.method === 'GET' && call.url === `${API}/apps/${APP}`)
        return json(404, { error: 'not found' });
      if (call.method === 'POST' && call.url === `${API}/apps`) return json(201, { id: 'app-1' });
      if (call.method === 'POST' && call.url.endsWith('/volumes')) {
        return json(200, {
          id: 'vol_1',
          name: call.body?.['name'],
          created_at: '2026-09-28T10:00:00Z',
        });
      }
      if (call.method === 'POST' && call.url.endsWith('/machines'))
        return json(200, flyMachine('created'));
      return json(500, {});
    };
    const handle = await flyPersistentOrchestrator.provisionPersistent(SPEC);
    expect(handle).toMatchObject({
      provider: 'fly',
      app: APP,
      machineId: 'm-1',
      volumeId: 'vol_1',
      region: 'iad',
    });

    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      `GET /apps/${APP}`,
      'POST /apps',
      `POST /apps/${APP}/volumes`,
      `POST /apps/${APP}/machines`,
    ]);
    expect(calls[1]!.body).toEqual({ app_name: APP, org_slug: 'motir-fleet', network: APP });
    expect(calls[2]!.body).toEqual({
      name: instanceVolumeName('cmInstance1'),
      region: 'iad',
      size_gb: 10,
    });
    const config = calls[3]!.body!['config'] as Record<string, unknown>;
    expect(config['auto_destroy']).toBe(false);
    expect(config['restart']).toEqual({ policy: 'on-failure' });
    expect(config['mounts']).toEqual([{ volume: 'vol_1', path: '/home/node' }]);
    expect(config['image']).toBe(SPEC.image);
    expect(config['guest']).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 8192 });
    expect((config['metadata'] as Record<string, string>)[INSTANCE_METADATA_KEY]).toBe(
      'cmInstance1',
    );
    expect(calls[3]!.body!['name']).toBe(instanceMachineName('cmInstance1'));
  });

  it('never uses the fleet token or the fleet app', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, { id: 'app-1' });
      if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_1', name: 'x' });
      return json(200, flyMachine('created'));
    };
    await flyPersistentOrchestrator.provisionPersistent(SPEC);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.auth).toBe('Bearer instances-token');
      expect(call.url).not.toContain('motir-ci-fleet');
    }
  });

  it('skips the app create when the app exists, and tolerates a concurrent create', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, { id: 'app-1' });
      if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_1', name: 'x' });
      return json(200, flyMachine('created'));
    };
    await flyPersistentOrchestrator.provisionPersistent(SPEC);
    expect(calls.some((c) => c.url === `${API}/apps` && c.method === 'POST')).toBe(false);

    for (const answer of [
      json(409, { error: 'exists' }),
      json(422, { error: 'app name already taken' }),
    ]) {
      calls = [];
      handler = (call) => {
        if (call.method === 'GET') return json(404, {});
        if (call.url === `${API}/apps`) return answer.clone();
        if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_1', name: 'x' });
        return json(200, flyMachine('created'));
      };
      await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).resolves.toMatchObject({
        machineId: 'm-1',
      });
    }
  });

  it('throws on an app create Fly refuses, and on an app read that is neither 200 nor 404', async () => {
    handler = (call) => (call.method === 'GET' ? json(404, {}) : json(403, { error: 'forbidden' }));
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      OrchestratorApiError,
    );
    handler = () => json(401, { error: 'unauthorized' });
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      OrchestratorApiError,
    );
    expect(calls.filter((c) => c.url.endsWith('/volumes'))).toEqual([]);
  });

  it('DESTROYS THE VOLUME when the machine create fails, and names an unpullable image', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.method === 'POST' && call.url.endsWith('/volumes'))
        return json(200, { id: 'vol_9', name: 'x' });
      if (call.method === 'POST' && call.url.endsWith('/machines')) {
        return json(400, { error: 'failed to get manifest ghcr.io/x: unauthorized' });
      }
      if (call.method === 'DELETE') return json(200, {});
      return json(500, {});
    };
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      OrchestratorImageUnpullableError,
    );
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${API}/apps/${APP}/volumes/vol_9`,
    });

    // A plain refusal is an API error, and a cleanup that itself fails still
    // surfaces the ORIGINAL error.
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.url.endsWith('/volumes')) return json(200, { id: 'vol_9', name: 'x' });
      if (call.url.endsWith('/machines')) return json(500, { error: 'capacity' });
      return json(500, { error: 'cannot delete' });
    };
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(/capacity/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses a volume or machine answer it cannot read', async () => {
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.url.endsWith('/volumes')) return json(200, { nope: true });
      return json(200, flyMachine('created'));
    };
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      /unexpected shape/,
    );
    handler = (call) => {
      if (call.method === 'GET') return json(200, {});
      if (call.url.endsWith('/volumes') && call.method === 'POST')
        return json(200, { id: 'vol_1', name: 'x' });
      if (call.url.endsWith('/machines')) return json(200, { nope: true });
      return json(200, {});
    };
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      /unexpected shape/,
    );
    handler = (call) =>
      call.method === 'GET' ? json(200, {}) : json(500, { error: 'volume quota' });
    await expect(flyPersistentOrchestrator.provisionPersistent(SPEC)).rejects.toThrow(
      /volume quota/,
    );
  });
});

describe('stop and start', () => {
  it('stop is a POST …/stop, and idempotent on a machine already stopped', async () => {
    handler = () => json(200, {});
    await flyPersistentOrchestrator.stop(HANDLE);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/apps/${APP}/machines/m-1/stop` });

    handler = (call) =>
      call.method === 'POST'
        ? json(400, { error: 'machine not running' })
        : json(200, flyMachine('stopped'));
    await expect(flyPersistentOrchestrator.stop(HANDLE)).resolves.toBeUndefined();
    handler = (call) => (call.method === 'POST' ? json(400, { error: 'x' }) : json(404, {}));
    await expect(flyPersistentOrchestrator.stop(HANDLE)).rejects.toThrow(OrchestratorApiError);
    handler = (call) =>
      call.method === 'POST' ? json(500, { error: 'boom' }) : json(200, flyMachine('started'));
    await expect(flyPersistentOrchestrator.stop(HANDLE)).rejects.toThrow(/boom/);
  });

  it('start is a POST …/start — a cold boot — idempotent on a machine already running', async () => {
    handler = () => json(200, {});
    await flyPersistentOrchestrator.start(HANDLE);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/apps/${APP}/machines/m-1/start`,
    });
    handler = (call) =>
      call.method === 'POST'
        ? json(400, { error: 'already started' })
        : json(200, flyMachine('started'));
    await expect(flyPersistentOrchestrator.start(HANDLE)).resolves.toBeUndefined();
    handler = (call) =>
      call.method === 'POST'
        ? json(503, { error: 'no capacity' })
        : json(200, flyMachine('stopped'));
    await expect(flyPersistentOrchestrator.start(HANDLE)).rejects.toThrow(/no capacity/);
  });
});

describe('describePersistent', () => {
  it('maps Fly states to the instance vocabulary, where `stopped` is NOT terminal', () => {
    expect(toPersistentState('created')).toBe('starting');
    expect(toPersistentState('starting')).toBe('starting');
    expect(toPersistentState('replacing')).toBe('starting');
    expect(toPersistentState('started')).toBe('running');
    expect(toPersistentState('stopping')).toBe('stopping');
    expect(toPersistentState('suspending')).toBe('stopping');
    expect(toPersistentState('stopped')).toBe('stopped');
    expect(toPersistentState('suspended')).toBe('stopped');
    expect(toPersistentState('destroying')).toBe('gone');
    expect(toPersistentState('destroyed')).toBe('gone');
    expect(toPersistentState('failed')).toBe('failed');
    expect(toPersistentState('something-new')).toBe('starting');
  });

  it('reads the CURRENT run’s start and stop — never the first start', async () => {
    const events = [
      { type: 'start', status: 'started', timestamp: Date.parse('2026-09-28T09:00:00Z') },
      { type: 'stop', status: 'stopped', timestamp: Date.parse('2026-09-28T09:30:00Z') },
      { type: 'start', status: 'started', timestamp: Date.parse('2026-09-28T12:00:00Z') },
    ];
    handler = () => json(200, flyMachine('started', events));
    const running = await flyPersistentOrchestrator.describePersistent(HANDLE);
    expect(running).toMatchObject({ state: 'running', providerState: 'started', stoppedAt: null });
    expect(running.startedAt?.toISOString()).toBe('2026-09-28T12:00:00.000Z');

    handler = () =>
      json(
        200,
        flyMachine('stopped', [
          ...events,
          { type: 'exit', status: 'stopped', timestamp: Date.parse('2026-09-28T12:45:00Z') },
        ]),
      );
    const stopped = await flyPersistentOrchestrator.describePersistent(HANDLE);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stoppedAt?.toISOString()).toBe('2026-09-28T12:45:00.000Z');
  });

  it('reports a machine Fly no longer has as `gone`, and throws on a failed read', async () => {
    handler = () => json(404, {});
    expect(await flyPersistentOrchestrator.describePersistent(HANDLE)).toEqual({
      machineId: 'm-1',
      state: 'gone',
      providerState: '',
      startedAt: null,
      stoppedAt: null,
    });
    handler = () => json(500, { error: 'down' });
    await expect(flyPersistentOrchestrator.describePersistent(HANDLE)).rejects.toThrow(
      OrchestratorApiError,
    );
  });

  it('currentRunInstants tolerates events without timestamps and a machine that never started', () => {
    const machine = toFlyMachine(
      flyMachine('stopped', [
        { type: 'start', status: 'started' },
        { type: 'stop', status: 'stopped', timestamp: Date.parse('2026-09-28T09:30:00Z') },
        { type: 'exit', status: 'stopped' },
      ]),
    )!;
    expect(currentRunInstants(machine)).toEqual({
      startedAt: null,
      stoppedAt: new Date('2026-09-28T09:30:00Z'),
    });
  });
});

describe('destroyPersistent', () => {
  it('destroys the machine, waits for it to be gone, THEN destroys the volume', async () => {
    let reads = 0;
    handler = (call) => {
      if (call.method === 'DELETE') return json(200, {});
      reads += 1;
      return reads < 3 ? json(200, flyMachine('destroying')) : json(404, {});
    };
    // `destroying` maps to gone, so the first read already releases.
    await flyPersistentOrchestrator.destroyPersistent(HANDLE);
    const order = calls.map((c) => `${c.method} ${c.url.replace(`${API}/apps/${APP}`, '')}`);
    expect(order[0]).toBe('DELETE /machines/m-1?force=true');
    expect(order.at(-1)).toBe('DELETE /volumes/vol_1');
    expect(order.indexOf('DELETE /volumes/vol_1')).toBeGreaterThan(
      order.indexOf('GET /machines/m-1'),
    );
  });

  it('never destroys the volume while the machine still exists — gives up and throws', async () => {
    handler = (call) =>
      call.method === 'DELETE' ? json(200, {}) : json(200, flyMachine('started'));
    await expect(flyPersistentOrchestrator.destroyPersistent(HANDLE)).rejects.toThrow(
      /did not release/,
    );
    expect(calls.filter((c) => c.url.includes('/volumes/'))).toEqual([]);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(VOLUME_RELEASE_ATTEMPTS);
  });

  it('is idempotent — a 404 on the machine and on the volume is the end state', async () => {
    handler = () => json(404, {});
    await expect(flyPersistentOrchestrator.destroyPersistent(HANDLE)).resolves.toBeUndefined();
    handler = (call) =>
      call.url.includes('/volumes/') ? json(500, { error: 'busy' }) : json(404, {});
    await expect(flyPersistentOrchestrator.destroyPersistent(HANDLE)).rejects.toThrow(/busy/);
    handler = () => json(500, { error: 'machine delete failed' });
    await expect(flyPersistentOrchestrator.destroyPersistent(HANDLE)).rejects.toThrow(
      /machine delete failed/,
    );
  });

  it('destroys one orphan machine or volume by id', async () => {
    handler = () => json(200, {});
    await flyPersistentOrchestrator.destroyMachine(APP, 'm-9');
    await flyPersistentOrchestrator.destroyVolume(APP, 'vol_9');
    expect(calls.map((c) => c.url.replace(`${API}/apps/${APP}`, ''))).toEqual([
      '/machines/m-9?force=true',
      '/volumes/vol_9',
    ]);
  });
});

describe('listPersistent — the reconcile’s read', () => {
  it('lists machines with their instance id and volumes with their attachment', async () => {
    handler = (call) => {
      if (call.url.endsWith('/machines')) {
        return json(200, [
          flyMachine('stopped', [], { [INSTANCE_METADATA_KEY]: 'cmInstance1' }),
          { junk: true },
        ]);
      }
      return json(200, [
        {
          id: 'vol_1',
          name: 'home_x',
          attached_machine_id: 'm-1',
          created_at: '2026-09-28T10:00:00Z',
        },
        { id: 'vol_2', name: 'home_y', attached_machine_id: '' },
        'junk',
      ]);
    };
    const inventory = await flyPersistentOrchestrator.listPersistent(APP);
    expect(inventory.machines).toEqual([
      {
        machineId: 'm-1',
        state: 'stopped',
        instanceId: 'cmInstance1',
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
      },
    ]);
    expect(inventory.volumes).toEqual([
      {
        volumeId: 'vol_1',
        name: 'home_x',
        attachedMachineId: 'm-1',
        createdAt: new Date('2026-09-28T10:00:00Z'),
      },
      { volumeId: 'vol_2', name: 'home_y', attachedMachineId: null, createdAt: null },
    ]);
  });

  it('reads an app that does not exist as empty, and a machine with no metadata as unowned', async () => {
    handler = () => json(404, {});
    expect(await flyPersistentOrchestrator.listPersistent(APP)).toEqual({
      app: APP,
      machines: [],
      volumes: [],
    });
    handler = (call) =>
      call.url.endsWith('/machines') ? json(200, [flyMachine('started')]) : json(404, {});
    const inventory = await flyPersistentOrchestrator.listPersistent(APP);
    expect(inventory.machines[0]!.instanceId).toBeNull();
    expect(inventory.volumes).toEqual([]);
    handler = (call) =>
      call.url.endsWith('/machines') ? json(200, {}) : json(500, { error: 'x' });
    await expect(flyPersistentOrchestrator.listPersistent(APP)).rejects.toThrow(
      OrchestratorApiError,
    );
  });
});

describe('the ephemeral path is unchanged', () => {
  it('flyOrchestrator.provision still sends auto_destroy: true and restart: no, to the FLEET app', async () => {
    handler = () => json(200, flyMachine('created'));
    await flyOrchestrator.provision({
      orgId: 'org-1',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      repoFullName: 'motir-projects/acme',
      workload: 'ci_runner',
      workflowJobId: 1,
      image: 'registry.fly.io/runner@sha256:abc',
      size: FLEET_CONTAINER_SIZE,
      env: {},
      timeoutSeconds: 60,
      region: 'iad',
    });
    const config = calls[0]!.body!['config'] as Record<string, unknown>;
    expect(config['auto_destroy']).toBe(true);
    expect(config['restart']).toEqual({ policy: 'no' });
    expect(config['mounts']).toBeUndefined();
    expect(calls[0]!.url).toBe(`${API}/apps/motir-ci-fleet/machines`);
    expect(calls[0]!.auth).toBe('Bearer fleet-token');
  });
});
