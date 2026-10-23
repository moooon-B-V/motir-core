import {
  CI_DOCKER_VOLUME_NAME,
  FLEET_CONTAINER_SIZE,
  flyOrchestrator,
  type ContainerSpec,
  type UsageAttribution,
} from '../../src/index';
import type { OrchestratorContractHarness } from './orchestratorContract';

// The Fly adapter behind the shared contract suite (MOTIR-8960), driven as
// `lib/orchestrator/index.ts` builds it, against an in-memory Fly Machines API.
//
// The API keeps machines and volumes in maps and answers the endpoints the
// adapter calls, the way Fly does: a machine that is gone is a 404 on GET and
// DELETE, a destroyed machine releases its volumes, and an `auto_destroy`
// machine whose job ended is simply no longer listed. The test file installs
// `flyMachinesApi` as `fetch`; the harness controls arrange its next answer.

export const FLY_APP = 'motir-ci-fleet';
export const FLY_IMAGE = 'registry.fly.io/motir-ci-runner@sha256:abc123';

interface StoredMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  config: { metadata: Record<string, string>; mounts?: Array<{ volume: string; path: string }> };
  events: Array<{ type: string; status: string; timestamp: number }>;
}

interface StoredVolume {
  id: string;
  name: string;
  region: string;
  created_at: string;
  attached_machine_id: string | null;
}

const machines = new Map<string, StoredMachine>();
const volumes = new Map<string, StoredVolume>();
let sequence = 0;
let failCreate = false;
/** An arranged capacity answer for the next machine create. */
let refuseCreate: { status: number; error: string } | null = null;
let failDestroy = false;
let startNext = true;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NOT_FOUND = () => json(404, { error: 'not found' });

/** The in-memory Fly Machines API, as a `fetch`. */
export async function flyMachinesApi(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const path = url.pathname.replace(`/v1/apps/${FLY_APP}`, '');
  const [, collection, id] = path.split('/');

  if (collection === 'machines' && !id && method === 'POST') {
    if (failCreate) {
      failCreate = false;
      return json(500, { error: 'machine create failed' });
    }
    if (refuseCreate) {
      const { status, error } = refuseCreate;
      refuseCreate = null;
      return json(status, { error });
    }
    sequence += 1;
    const config = body['config'] as StoredMachine['config'];
    const now = Date.now();
    const machine: StoredMachine = {
      id: `m${sequence}`,
      name: String(body['name']),
      state: startNext ? 'started' : 'created',
      region: String(body['region']),
      created_at: new Date(now).toISOString(),
      config: { metadata: config.metadata, ...(config.mounts ? { mounts: config.mounts } : {}) },
      events: startNext ? [{ type: 'start', status: 'started', timestamp: now }] : [],
    };
    startNext = true;
    for (const mount of machine.config.mounts ?? []) {
      const volume = volumes.get(mount.volume);
      if (volume) volume.attached_machine_id = machine.id;
    }
    machines.set(machine.id, machine);
    return json(200, machine);
  }
  if (collection === 'machines' && !id) return json(200, [...machines.values()]);
  if (collection === 'machines' && method === 'GET') {
    const machine = machines.get(id!);
    return machine ? json(200, machine) : NOT_FOUND();
  }
  if (collection === 'machines' && method === 'DELETE') {
    if (failDestroy) {
      failDestroy = false;
      return json(500, { error: 'machine destroy failed' });
    }
    if (!destroyMachine(id!)) return NOT_FOUND();
    return json(200, { ok: true });
  }
  if (collection === 'volumes' && !id && method === 'POST') {
    sequence += 1;
    return json(200, storeVolume(`vol_${sequence}`, String(body['name']), new Date()));
  }
  if (collection === 'volumes' && !id) return json(200, [...volumes.values()]);
  if (collection === 'volumes' && method === 'DELETE') {
    return volumes.delete(id!) ? json(200, { ok: true }) : NOT_FOUND();
  }
  return json(400, { error: `unhandled ${method} ${url.pathname}` });
}

/** Remove a machine and release its volumes. Answers whether it existed. */
function destroyMachine(id: string): boolean {
  const machine = machines.get(id);
  if (!machine) return false;
  machines.delete(id);
  for (const volume of volumes.values()) {
    if (volume.attached_machine_id === id) volume.attached_machine_id = null;
  }
  return true;
}

function storeVolume(id: string, name: string, createdAt: Date): StoredVolume {
  const volume: StoredVolume = {
    id,
    name,
    region: 'iad',
    created_at: createdAt.toISOString(),
    attached_machine_id: null,
  };
  volumes.set(id, volume);
  return volume;
}

const SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  image: FLY_IMAGE,
  size: FLEET_CONTAINER_SIZE,
  env: { ACTIONS_RUNNER_INPUT_JITCONFIG: 'jit' },
  timeoutSeconds: 3600,
  region: 'iad',
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

function machineOf(id: string): StoredMachine {
  const machine = machines.get(id);
  if (!machine) throw new Error(`the Fly API fake has no machine ${id}`);
  return machine;
}

export function flyHarness(): OrchestratorContractHarness {
  return {
    orchestrator: flyOrchestrator,
    reset() {
      machines.clear();
      volumes.clear();
      sequence = 0;
      failCreate = false;
      refuseCreate = null;
      failDestroy = false;
      startNext = true;
    },
    spec: (overrides = {}) => ({ ...SPEC, ...overrides }),
    attribution: (overrides = {}) => ({ ...ATTRIBUTION, ...overrides }),
    failNextProvision: () => {
      failCreate = true;
    },
    // Fly has no "out of stock" answer on the Machines API, so the harness does
    // not declare it.
    capacityReasons: ['quota_exceeded', 'throttled'],
    refuseNextProvisionForCapacity: (reason) => {
      refuseCreate =
        reason === 'quota_exceeded'
          ? { status: 422, error: 'Your organization has reached its machine limit' }
          : { status: 429, error: 'rate limit exceeded' };
    },
    failNextTeardown: () => {
      failDestroy = true;
    },
    neverStart: () => {
      startNext = false;
    },
    // `auto_destroy`: the runner exits and the machine deletes itself — Fly
    // keeps no record of it, or of its exit code.
    completeJob: (handle) => {
      machineOf(handle.id);
      destroyMachine(handle.id);
    },
    backdate: (handle, createdAt) => {
      machineOf(handle.id).created_at = createdAt.toISOString();
    },
    liveContainerIds: () => [...machines.keys()],
    liveVolumeIds: () => [...volumes.keys()],
    orphanVolume: (createdAt) => {
      sequence += 1;
      return storeVolume(`vol_${sequence}`, CI_DOCKER_VOLUME_NAME, createdAt).id;
    },
  };
}
