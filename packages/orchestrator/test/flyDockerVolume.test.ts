import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CI_DOCKER_VOLUME_NAME,
  CI_DOCKER_VOLUME_PATH,
  FLEET_CONTAINER_SIZE,
  FLEET_METADATA_KEY,
  FLEET_METADATA_VALUES,
  MACHINE_CREATE_VOLUME_ATTEMPTS,
  OrchestratorApiError,
  VOLUME_DESTROY_ATTEMPTS,
  flyMachinesClient,
  flyOrchestrator,
  toFlyMachine,
  toFlyVolume,
  type ContainerHandle,
  type ContainerSpec,
  type UsageAttribution,
} from '../src/index';

// A CI runner's Docker volume (MOTIR-8839). On a Fly Machine's rootfs the
// runner's dockerd can use neither overlay driver, and the `vfs` fallback fills
// the disk on the first `services:` job, so the adapter gives the daemon its own
// ext4 volume at `/var/lib/docker` and owns its whole life: created with the
// machine, deleted with it, swept if it is ever left.
//
// No database. `fetch` is the only fake.

const APP = 'motir-ci-fleet';
const IMAGE = 'registry.fly.io/motir-ci-runner@sha256:abc123';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function machineBody(
  overrides: { mounts?: unknown; metadata?: Record<string, string> } = {},
): Record<string, unknown> {
  return {
    id: 'd8901ab',
    name: 'motir-runner-44001',
    state: 'started',
    region: 'iad',
    created_at: '2026-10-17T08:00:00.000Z',
    config: {
      metadata: overrides.metadata ?? {
        [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES.ci_runner,
      },
      ...(overrides.mounts !== undefined ? { mounts: overrides.mounts } : {}),
    },
    events: [],
  };
}

function volumeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vol_1',
    name: CI_DOCKER_VOLUME_NAME,
    region: 'iad',
    created_at: '2026-10-17T07:00:00.000Z',
    attached_machine_id: null,
    ...overrides,
  };
}

const SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'moooon-B-V/motir-ai',
  workload: 'ci_runner',
  workflowJobId: 44001,
  image: IMAGE,
  size: FLEET_CONTAINER_SIZE,
  env: { ACTIONS_RUNNER_INPUT_JITCONFIG: 'secret-config' },
  timeoutSeconds: 3600,
  region: 'iad',
  dockerVolumeGb: 20,
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'moooon-B-V/motir-ai',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

const HANDLE: ContainerHandle = {
  provider: 'fly',
  id: 'd8901ab',
  region: 'iad',
  createdAt: new Date('2026-10-17T08:00:00.000Z'),
};

const isVolumes = (c: Call) => c.url.endsWith(`/apps/${APP}/volumes`);
const isVolume = (id: string) => (c: Call) => c.url.endsWith(`/apps/${APP}/volumes/${id}`);
const isMachines = (c: Call) => c.url.endsWith(`/apps/${APP}/machines`);

beforeEach(() => {
  calls = [];
  handler = () => json(200, {});
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
  vi.stubEnv('FLY_FLEET_APP', APP);
  vi.stubEnv('MOTIR_RUNNER_IMAGE', IMAGE);
  vi.stubEnv('FLY_FLEET_REGION', 'iad');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('provision — a spec that asks for a Docker volume gets one', () => {
  it('creates the volume first, in the machine region, and mounts it at /var/lib/docker', async () => {
    handler = (c) =>
      c.method === 'POST' && isVolumes(c) ? json(200, volumeBody()) : json(200, machineBody());

    const handle = await flyOrchestrator.provision(SPEC);

    expect(calls.map((c) => [c.method, isVolumes(c) ? 'volumes' : 'machines'])).toEqual([
      ['POST', 'volumes'],
      ['POST', 'machines'],
    ]);
    expect(calls[0]!.body).toEqual({ name: CI_DOCKER_VOLUME_NAME, region: 'iad', size_gb: 20 });
    const config = calls[1]!.body!['config'] as Record<string, unknown>;
    expect(config['mounts']).toEqual([{ volume: 'vol_1', path: CI_DOCKER_VOLUME_PATH }]);
    expect(handle.volumeId).toBe('vol_1');
  });

  it('a spec without one creates no volume and mounts nothing', async () => {
    handler = () => json(200, machineBody());
    const { dockerVolumeGb: _omit, ...plain } = SPEC;

    const handle = await flyOrchestrator.provision(plain);

    expect(calls).toHaveLength(1);
    expect(isMachines(calls[0]!)).toBe(true);
    expect((calls[0]!.body!['config'] as Record<string, unknown>)['mounts']).toBeUndefined();
    expect(handle.volumeId).toBeUndefined();
  });

  it('a size of 0 is "no volume"', async () => {
    handler = () => json(200, machineBody());
    await flyOrchestrator.provision({ ...SPEC, dockerVolumeGb: 0 });
    expect(calls.some(isVolumes)).toBe(false);
  });

  it('a machine create that fails deletes the volume it would have mounted, and rethrows', async () => {
    handler = (c) => {
      if (c.method === 'POST' && isVolumes(c)) return json(200, volumeBody());
      if (c.method === 'POST' && isMachines(c)) return json(422, { error: 'no capacity' });
      return json(200, {});
    };

    await expect(flyOrchestrator.provision(SPEC)).rejects.toThrow(OrchestratorApiError);
    expect(calls.some((c) => c.method === 'DELETE' && isVolume('vol_1')(c))).toBe(true);
  });

  it('a machine create refused with `volume not found` is asked again once the volume is visible (MOTIR-8941)', async () => {
    vi.useFakeTimers();
    let machineCreates = 0;
    handler = (c) => {
      if (c.method === 'POST' && isVolumes(c)) return json(200, volumeBody());
      if (c.method === 'POST' && isMachines(c)) {
        machineCreates += 1;
        return machineCreates < 3
          ? json(400, { error: 'volume vol_1 not found' })
          : json(200, machineBody());
      }
      return json(200, {});
    };

    const provisioned = flyOrchestrator.provision(SPEC);
    await vi.runAllTimersAsync();
    const handle = await provisioned;

    expect(machineCreates).toBe(3);
    expect(handle.volumeId).toBe('vol_1');
    expect(calls.some((c) => c.method === 'DELETE' && isVolume('vol_1')(c))).toBe(false);
  });

  it('a `volume not found` that never clears is thrown after the bounded asks, and the volume deleted', async () => {
    vi.useFakeTimers();
    let machineCreates = 0;
    handler = (c) => {
      if (c.method === 'POST' && isVolumes(c)) return json(200, volumeBody());
      if (c.method === 'POST' && isMachines(c)) {
        machineCreates += 1;
        return json(400, { error: 'volume vol_1 not found' });
      }
      return json(200, {});
    };

    const provisioned = flyOrchestrator.provision(SPEC);
    const settled = expect(provisioned).rejects.toThrow(OrchestratorApiError);
    await vi.runAllTimersAsync();
    await settled;

    expect(machineCreates).toBe(MACHINE_CREATE_VOLUME_ATTEMPTS);
    expect(calls.some((c) => c.method === 'DELETE' && isVolume('vol_1')(c))).toBe(true);
  });

  it('a volume create that fails creates no machine', async () => {
    handler = () => json(500, { error: 'volumes down' });
    await expect(flyOrchestrator.provision(SPEC)).rejects.toThrow(OrchestratorApiError);
    expect(calls.some(isMachines)).toBe(false);
  });

  it('a volume create answering an unexpected shape is an API error', async () => {
    handler = () => json(200, { nope: true });
    await expect(flyOrchestrator.provision(SPEC)).rejects.toThrow(/unexpected shape/);
  });
});

describe('teardown — the volume goes with its machine', () => {
  it('deletes the handle’s volume after destroying the machine', async () => {
    handler = (c) => (c.method === 'GET' ? json(404, {}) : json(200, {}));

    await flyOrchestrator.teardown({ ...HANDLE, volumeId: 'vol_1' }, 'job_completed', ATTRIBUTION);

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes[0]).toContain('/machines/d8901ab');
    expect(deletes[1]).toContain('/volumes/vol_1');
  });

  it('keeps asking while the destroyed machine still holds the volume', async () => {
    vi.useFakeTimers();
    let refusals = 2;
    handler = (c) => {
      if (c.method === 'DELETE' && isVolume('vol_1')(c)) {
        if (refusals > 0) {
          refusals -= 1;
          return json(412, { error: 'volume is attached' });
        }
        return json(200, {});
      }
      return c.method === 'GET' ? json(404, {}) : json(200, {});
    };

    const done = flyOrchestrator.teardown(
      { ...HANDLE, volumeId: 'vol_1' },
      'job_completed',
      ATTRIBUTION,
    );
    await vi.runAllTimersAsync();
    await done;

    expect(calls.filter((c) => c.method === 'DELETE' && isVolume('vol_1')(c))).toHaveLength(3);
  });

  it('gives up after its attempts, leaves the volume to the sweep, and still returns the usage row', async () => {
    vi.useFakeTimers();
    handler = (c) => {
      if (c.method === 'DELETE' && isVolume('vol_1')(c)) return json(412, { error: 'attached' });
      return c.method === 'GET' ? json(404, {}) : json(200, {});
    };

    const done = flyOrchestrator.teardown(
      { ...HANDLE, volumeId: 'vol_1' },
      'job_completed',
      ATTRIBUTION,
    );
    await vi.runAllTimersAsync();
    const usage = await done;

    expect(usage.handleId).toBe('d8901ab');
    expect(calls.filter((c) => c.method === 'DELETE' && isVolume('vol_1')(c))).toHaveLength(
      VOLUME_DESTROY_ATTEMPTS,
    );
  });

  it('a handle rebuilt from a listing finds a CI runner’s volume in its mounts', async () => {
    handler = (c) =>
      c.method === 'GET'
        ? json(200, machineBody({ mounts: [{ volume: 'vol_9', path: CI_DOCKER_VOLUME_PATH }] }))
        : json(200, {});

    await flyOrchestrator.teardown(HANDLE, 'reaped', ATTRIBUTION);

    expect(calls.some((c) => c.method === 'DELETE' && isVolume('vol_9')(c))).toBe(true);
  });

  it('never deletes what another workload mounts', async () => {
    handler = (c) =>
      c.method === 'GET'
        ? json(
            200,
            machineBody({
              metadata: { [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES.agent_instance },
              mounts: [{ volume: 'vol_home', path: '/home' }],
            }),
          )
        : json(200, {});

    await flyOrchestrator.teardown(HANDLE, 'reaped', ATTRIBUTION);

    expect(calls.some((c) => c.url.includes('/volumes/'))).toBe(false);
  });

  it('a machine with no handle volume and no mounts deletes no volume', async () => {
    handler = (c) => (c.method === 'GET' ? json(404, {}) : json(200, {}));
    await flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION);
    expect(calls.some((c) => c.url.includes('/volumes/'))).toBe(false);
  });
});

describe('sweepOrphanedVolumes — the backstop', () => {
  const OLDER_THAN = new Date('2026-10-17T07:50:00.000Z');

  it('destroys only unattached CI Docker volumes older than the cutoff', async () => {
    handler = (c) => {
      if (c.method === 'GET' && isVolumes(c)) {
        return json(200, [
          volumeBody({ id: 'orphan' }),
          volumeBody({ id: 'attached', attached_machine_id: 'm1' }),
          volumeBody({ id: 'other', name: 'agent_home' }),
          volumeBody({ id: 'young', created_at: '2026-10-17T07:55:00.000Z' }),
          volumeBody({ id: 'undated', created_at: null }),
          { not: 'a volume' },
        ]);
      }
      return json(200, {});
    };

    const destroyed = await flyOrchestrator.sweepOrphanedVolumes!(OLDER_THAN);

    expect(destroyed).toBe(1);
    const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain('/volumes/orphan');
  });

  it('a volume Fly refuses to delete is not counted', async () => {
    handler = (c) =>
      c.method === 'GET' ? json(200, [volumeBody({ id: 'orphan' })]) : json(500, { error: 'no' });
    expect(await flyOrchestrator.sweepOrphanedVolumes!(OLDER_THAN)).toBe(0);
  });

  it('a listing failure sweeps nothing and does not throw', async () => {
    handler = () => json(503, { error: 'down' });
    expect(await flyOrchestrator.sweepOrphanedVolumes!(OLDER_THAN)).toBe(0);
  });

  it('a non-array listing is an empty one', async () => {
    handler = () => json(200, { volumes: [] });
    expect(await flyOrchestrator.sweepOrphanedVolumes!(OLDER_THAN)).toBe(0);
  });
});

describe('the volume wire shapes', () => {
  it('toFlyVolume reads id, name, region, creation and attachment', () => {
    expect(toFlyVolume(volumeBody({ attached_machine_id: 'm1' }))).toEqual({
      id: 'vol_1',
      name: CI_DOCKER_VOLUME_NAME,
      region: 'iad',
      createdAt: new Date('2026-10-17T07:00:00.000Z'),
      attachedMachineId: 'm1',
    });
    expect(toFlyVolume({ id: 'v', attached_machine_id: '' })).toMatchObject({
      name: '',
      region: '',
      attachedMachineId: null,
    });
    expect(toFlyVolume(null)).toBeNull();
    expect(toFlyVolume({ id: '' })).toBeNull();
  });

  it('toFlyMachine reads mounted volume ids and ignores malformed mounts', () => {
    expect(
      toFlyMachine(machineBody({ mounts: [{ volume: 'a' }, { volume: '' }, 'x', { path: '/p' }] }))
        ?.mountedVolumeIds,
    ).toEqual(['a']);
    expect(
      toFlyMachine(machineBody({ mounts: [{ path: '/p' }] }))?.mountedVolumeIds,
    ).toBeUndefined();
    expect(toFlyMachine(machineBody())?.mountedVolumeIds).toBeUndefined();
  });

  it('destroyVolume treats 404 as already gone', async () => {
    handler = () => json(404, {});
    await expect(flyMachinesClient.destroyVolume('gone')).resolves.toBeUndefined();
  });
});
