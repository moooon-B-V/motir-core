import { createHash } from 'node:crypto';
import {
  flyErrorDetail,
  flyRequest,
  isFlyImagePullRefusal,
  parseFlyDate,
  readFlyJson,
  toFlyMachine,
  type FlyMachine,
} from './flyMachines';
import {
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
} from '../../errors';
import type {
  PersistentAppInventory,
  PersistentContainerHandle,
  PersistentContainerOrchestrator,
  PersistentContainerSpec,
  PersistentContainerState,
  PersistentContainerStatus,
  PersistentExecResult,
} from '../../types';

// The FLY adapter's PERSISTENT half (Story MOTIR-6860 · MOTIR-6869) — a user
// agent instance on Fly Machines, per `docs/decisions/agent-instances.md` §1–§3
// and §7. Still translation only: which instance to boot, when to hibernate it,
// and what a running interval costs all live above the port.
//
// ⚠️ IT NEVER READS `FLY_FLEET_*`. The fleet app is swept by the fleet reaper,
// which destroys every tagged machine older than its cutoff (§7, Context fact 1),
// and it would put a user's shell on the CI runners' private network. So the
// instance lane has its OWN configuration and its own token — a token for the
// fleet Fly ORGANISATION that may create apps — and there is no fallback to the
// fleet's. The CI fleet reaper never lists an instance app; the instance
// reconcile (`listPersistent`) is its equivalent.
//
// ⚠️ ONE APP PER MOTIR ORGANISATION, EACH ON ITS OWN PRIVATE NETWORK (§7).
// Machines in one Fly app share a 6PN, so one shared instances app would let a
// dev server one tenant binds to `0.0.0.0` answer every other tenant. The app is
// created lazily, on the organisation's first instance, with a custom `network`.
//
// ⚠️ NO `suspend` (§1, Rejected): Fly suspends only machines of ≤ 2 GB and the
// one priced agent machine is 8 GB, so hibernate is `stop` and every wake is a
// cold boot of the rootfs with the volume intact.

export interface FlyInstancesConfig {
  readonly token: string;
  readonly region: string;
  readonly appPrefix: string;
  /** The Fly organisation slug the instance apps are created in. */
  readonly org: string;
}

/**
 * The instance lane's configuration, or the typed not-configured error.
 *
 * `FLY_INSTANCES_REGION` defaults to `iad` and `FLY_INSTANCES_APP_PREFIX` to
 * `motir-inst` (§7). `FLY_INSTANCES_ORG` defaults to `motir-fleet` — the fleet
 * organisation §7 boots instances in (`code-graph-index-fleet.md` §3) — because
 * `POST /v1/apps` needs an organisation slug and the token alone does not name
 * one; it is a variable so a different deployment can point elsewhere.
 */
export function flyInstancesConfig(): FlyInstancesConfig {
  const token = process.env['FLY_INSTANCES_API_TOKEN'];
  if (!token) throw new OrchestratorNotConfiguredError('set FLY_INSTANCES_API_TOKEN');
  return {
    token,
    region: process.env['FLY_INSTANCES_REGION']?.trim() || 'iad',
    appPrefix: process.env['FLY_INSTANCES_APP_PREFIX']?.trim() || 'motir-inst',
    org: process.env['FLY_INSTANCES_ORG']?.trim() || 'motir-fleet',
  };
}

/** Is the instance lane wired on this deployment? Never throws. */
export function isFlyInstancesConfigured(): boolean {
  return Boolean(process.env['FLY_INSTANCES_API_TOKEN']);
}

/** Machine metadata naming the instance, so the reconcile can map a machine back to its record. */
export const INSTANCE_METADATA_KEY = 'motir_instance_id';

/** The first 16 hex digits of a SHA-256 — a stable, collision-resistant label for a name. */
function digest16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** `<prefix>-<hash of the organisation id>` (§7) — the app AND its network name. */
export function instanceAppName(appPrefix: string, orgId: string): string {
  return `${appPrefix}-${digest16(orgId)}`;
}

/**
 * The home volume's name for one instance. Fly volume names are lower-case
 * letters, digits and underscores, at most 30 characters, so the id is hashed
 * rather than embedded — and the reconcile can recompute it from a record.
 */
export function instanceVolumeName(instanceId: string): string {
  return `home_${digest16(instanceId)}`;
}

/** The machine's name — unique within the app because the instance id is. */
export function instanceMachineName(instanceId: string): string {
  return `instance-${instanceId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 63);
}

/** Fly's machine state → the instance vocabulary (§1). `stopped` is NOT terminal. */
export function toPersistentState(flyState: string): PersistentContainerState {
  switch (flyState) {
    case 'created':
    case 'starting':
    case 'replacing':
      return 'starting';
    case 'started':
      return 'running';
    case 'stopping':
    case 'suspending':
      return 'stopping';
    case 'stopped':
    case 'suspended':
      return 'stopped';
    case 'destroying':
    case 'destroyed':
      return 'gone';
    case 'failed':
      return 'failed';
    default:
      // An unrecognised state is treated as still in motion: the sweep asks
      // again in five minutes, where "failed" would act on a guess.
      return 'starting';
  }
}

/**
 * The start and stop instants of the CURRENT run: the latest `start` event, and
 * the latest `stop` / `exit` / `destroy` event at or after it. Never the first
 * start — that would measure an interval across the hibernated hours (§5,
 * Context fact 3).
 */
export function currentRunInstants(machine: FlyMachine): {
  startedAt: Date | null;
  stoppedAt: Date | null;
} {
  let startedAt: Date | null = null;
  for (const event of machine.events) {
    if (event.type !== 'start' || !event.timestamp) continue;
    if (!startedAt || event.timestamp.getTime() > startedAt.getTime()) startedAt = event.timestamp;
  }
  let stoppedAt: Date | null = null;
  for (const event of machine.events) {
    if (event.type !== 'stop' && event.type !== 'exit' && event.type !== 'destroy') continue;
    if (!event.timestamp) continue;
    if (startedAt && event.timestamp.getTime() < startedAt.getTime()) continue;
    if (!stoppedAt || event.timestamp.getTime() > stoppedAt.getTime()) stoppedAt = event.timestamp;
  }
  return { startedAt, stoppedAt };
}

/** How long `destroyPersistent` waits for a destroyed machine to release its volume. */
export const VOLUME_RELEASE_ATTEMPTS = 10;
export const VOLUME_RELEASE_INTERVAL_MS = 1000;

/** The pause between release polls — a module seam so a test need not wait real seconds. */
export const persistentTiming = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

function path(app: string, rest = ''): string {
  return `/apps/${encodeURIComponent(app)}${rest}`;
}

async function fail(res: Response): Promise<never> {
  throw new OrchestratorApiError('fly', res.status, flyErrorDetail(await readFlyJson(res)));
}

interface FlyVolume {
  id: string;
  name: string;
  attachedMachineId: string | null;
  createdAt: Date | null;
}

function toFlyVolume(body: unknown): FlyVolume | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const attached = record['attached_machine_id'];
  return {
    id,
    name: typeof record['name'] === 'string' ? record['name'] : '',
    attachedMachineId: typeof attached === 'string' && attached.length > 0 ? attached : null,
    createdAt: parseFlyDate(record['created_at']),
  };
}

/** The instance app's Machines-API calls, with the INSTANCE token. */
const flyInstancesClient = {
  /** Create the organisation's app with its own network, unless it exists. */
  async ensureApp(config: FlyInstancesConfig, app: string): Promise<void> {
    const existing = await flyRequest(path(app), { method: 'GET', token: config.token });
    if (existing.ok) return;
    if (existing.status !== 404) await fail(existing);
    const res = await flyRequest('/apps', {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({ app_name: app, org_slug: config.org, network: app }),
    });
    // A concurrent first instance of the same organisation may have created it
    // between the read and the write; "already exists" is the end state wanted.
    if (res.ok || res.status === 409) return;
    const body = await readFlyJson(res);
    if (res.status === 422 && /already/i.test(flyErrorDetail(body))) return;
    throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
  },

  async createVolume(
    config: FlyInstancesConfig,
    app: string,
    input: { name: string; region: string; sizeGb: number },
  ): Promise<FlyVolume> {
    const res = await flyRequest(path(app, '/volumes'), {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({ name: input.name, region: input.region, size_gb: input.sizeGb }),
    });
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    const volume = toFlyVolume(body);
    if (!volume)
      throw new OrchestratorApiError(
        'fly',
        res.status,
        'volume create returned an unexpected shape',
      );
    return volume;
  },

  async createMachine(
    config: FlyInstancesConfig,
    app: string,
    spec: PersistentContainerSpec,
    volumeId: string,
  ): Promise<FlyMachine> {
    const res = await flyRequest(path(app, '/machines'), {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({
        name: instanceMachineName(spec.instanceId),
        region: spec.region,
        config: {
          image: spec.image,
          guest: {
            cpu_kind: spec.size.cpuKind,
            cpus: spec.size.cpus,
            memory_mb: spec.size.memoryMb,
          },
          env: { ...spec.env },
          metadata: {
            [INSTANCE_METADATA_KEY]: spec.instanceId,
            motir_org_id: spec.orgId,
            motir_workspace_id: spec.workspaceId,
            motir_project_id: spec.projectId,
          },
          mounts: [{ volume: volumeId, path: spec.mountPath }],
          // §1: the machine OUTLIVES its process. A crashed main process is
          // restarted by Fly; an explicit stop through the API is not a failure,
          // so a hibernated instance stays stopped.
          auto_destroy: false,
          restart: { policy: 'on-failure' },
        },
      }),
    });
    const body = await readFlyJson(res);
    if (!res.ok) {
      const detail = flyErrorDetail(body);
      if (isFlyImagePullRefusal(detail)) {
        throw new OrchestratorImageUnpullableError('fly', res.status, spec.image, detail);
      }
      throw new OrchestratorApiError('fly', res.status, detail);
    }
    const machine = toFlyMachine(body);
    if (!machine)
      throw new OrchestratorApiError(
        'fly',
        res.status,
        'machine create returned an unexpected shape',
      );
    return machine;
  },

  async getMachine(
    config: FlyInstancesConfig,
    app: string,
    id: string,
  ): Promise<FlyMachine | null> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}`), {
      method: 'GET',
      token: config.token,
    });
    if (res.status === 404) return null;
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    return toFlyMachine(body);
  },

  async machineAction(
    config: FlyInstancesConfig,
    app: string,
    id: string,
    action: 'stop' | 'start',
  ): Promise<Response> {
    return flyRequest(path(app, `/machines/${encodeURIComponent(id)}/${action}`), {
      method: 'POST',
      token: config.token,
    });
  },

  async exec(
    config: FlyInstancesConfig,
    app: string,
    id: string,
    command: readonly string[],
    timeoutSeconds: number,
  ): Promise<PersistentExecResult> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}/exec`), {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({ cmd: [...command], timeout: timeoutSeconds }),
    });
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    return {
      exitCode: typeof record['exit_code'] === 'number' ? record['exit_code'] : -1,
      stdout: typeof record['stdout'] === 'string' ? record['stdout'] : '',
      stderr: typeof record['stderr'] === 'string' ? record['stderr'] : '',
    };
  },

  async destroyMachine(config: FlyInstancesConfig, app: string, id: string): Promise<void> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}?force=true`), {
      method: 'DELETE',
      token: config.token,
    });
    if (res.ok || res.status === 404) return;
    await fail(res);
  },

  async destroyVolume(config: FlyInstancesConfig, app: string, id: string): Promise<void> {
    const res = await flyRequest(path(app, `/volumes/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      token: config.token,
    });
    if (res.ok || res.status === 404) return;
    await fail(res);
  },

  async list<T>(
    config: FlyInstancesConfig,
    app: string,
    resource: 'machines' | 'volumes',
    parse: (entry: unknown) => T | null,
  ): Promise<T[] | null> {
    const res = await flyRequest(path(app, `/${resource}`), { method: 'GET', token: config.token });
    if (res.status === 404) return null;
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    return (Array.isArray(body) ? body : []).flatMap((entry) => {
      const parsed = parse(entry);
      return parsed ? [parsed] : [];
    });
  },
};

/**
 * Ask Fly for an action, and treat a refusal as success when the machine is
 * ALREADY where the action would have put it — a stop of a stopped machine, a
 * start of a started one. The refusal's wording is not a contract, so the answer
 * is read from the machine's own state rather than from the error text.
 */
async function actIdempotently(
  config: FlyInstancesConfig,
  handle: PersistentContainerHandle,
  action: 'stop' | 'start',
  settled: readonly PersistentContainerState[],
): Promise<void> {
  const res = await flyInstancesClient.machineAction(config, handle.app, handle.machineId, action);
  if (res.ok) return;
  const detail = flyErrorDetail(await readFlyJson(res));
  const machine = await flyInstancesClient.getMachine(config, handle.app, handle.machineId);
  const state: PersistentContainerState = machine ? toPersistentState(machine.state) : 'gone';
  if (settled.includes(state)) return;
  throw new OrchestratorApiError('fly', res.status, detail);
}

export const flyPersistentOrchestrator: PersistentContainerOrchestrator = {
  provider: 'fly',

  appNameFor(orgId: string): string {
    return instanceAppName(flyInstancesConfig().appPrefix, orgId);
  },

  defaultRegion(): string {
    return flyInstancesConfig().region;
  },

  async provisionPersistent(spec: PersistentContainerSpec): Promise<PersistentContainerHandle> {
    const config = flyInstancesConfig();
    const app = instanceAppName(config.appPrefix, spec.orgId);
    const region = spec.region || config.region;
    await flyInstancesClient.ensureApp(config, app);
    const volume = await flyInstancesClient.createVolume(config, app, {
      name: instanceVolumeName(spec.instanceId),
      region,
      sizeGb: spec.volumeSizeGb,
    });
    let machine: FlyMachine;
    try {
      machine = await flyInstancesClient.createMachine(config, app, { ...spec, region }, volume.id);
    } catch (err) {
      // Never leave an untracked volume: the caller never receives its id, so
      // nothing else would ever destroy it.
      try {
        await flyInstancesClient.destroyVolume(config, app, volume.id);
      } catch (cleanup) {
        console.error(
          '[flyPersistentOrchestrator] could not destroy the volume of a failed provision',
          {
            app,
            volumeId: volume.id,
            detail: cleanup instanceof Error ? cleanup.message : 'unknown',
          },
        );
      }
      throw err;
    }
    return {
      provider: 'fly',
      app,
      machineId: machine.id,
      volumeId: volume.id,
      region: machine.region || region,
      createdAt: machine.createdAt ?? new Date(),
    };
  },

  async stop(handle: PersistentContainerHandle): Promise<void> {
    await actIdempotently(flyInstancesConfig(), handle, 'stop', ['stopping', 'stopped']);
  },

  async start(handle: PersistentContainerHandle): Promise<void> {
    await actIdempotently(flyInstancesConfig(), handle, 'start', ['starting', 'running']);
  },

  async describePersistent(handle: PersistentContainerHandle): Promise<PersistentContainerStatus> {
    const config = flyInstancesConfig();
    const machine = await flyInstancesClient.getMachine(config, handle.app, handle.machineId);
    if (!machine) {
      return {
        machineId: handle.machineId,
        state: 'gone',
        providerState: '',
        startedAt: null,
        stoppedAt: null,
      };
    }
    const instants = currentRunInstants(machine);
    return {
      machineId: handle.machineId,
      state: toPersistentState(machine.state),
      providerState: machine.state,
      startedAt: instants.startedAt,
      stoppedAt: instants.stoppedAt,
    };
  },

  async destroyPersistent(handle: PersistentContainerHandle): Promise<void> {
    const config = flyInstancesConfig();
    await flyInstancesClient.destroyMachine(config, handle.app, handle.machineId);
    // NEVER the volume while the machine exists: a destroyed machine releases its
    // volume asynchronously, so wait for Fly to report the machine gone first.
    for (let attempt = 0; attempt < VOLUME_RELEASE_ATTEMPTS; attempt += 1) {
      const machine = await flyInstancesClient.getMachine(config, handle.app, handle.machineId);
      if (!machine || toPersistentState(machine.state) === 'gone') {
        await flyInstancesClient.destroyVolume(config, handle.app, handle.volumeId);
        return;
      }
      await persistentTiming.sleep(VOLUME_RELEASE_INTERVAL_MS);
    }
    // The volume is left for the next sweep's reconcile, which destroys a volume
    // no live record owns. Throwing tells the caller the delete is not finished.
    throw new OrchestratorApiError(
      'fly',
      null,
      `machine ${handle.machineId} did not release volume ${handle.volumeId} in time`,
    );
  },

  async listPersistent(app: string): Promise<PersistentAppInventory> {
    const config = flyInstancesConfig();
    const machines = await flyInstancesClient.list(config, app, 'machines', toFlyMachine);
    if (machines === null) return { app, machines: [], volumes: [] };
    const volumes = (await flyInstancesClient.list(config, app, 'volumes', toFlyVolume)) ?? [];
    return {
      app,
      machines: machines.map((m) => ({
        machineId: m.id,
        state: toPersistentState(m.state),
        instanceId: m.metadata[INSTANCE_METADATA_KEY] ?? null,
        createdAt: m.createdAt,
      })),
      volumes: volumes.map((v) => ({
        volumeId: v.id,
        name: v.name,
        attachedMachineId: v.attachedMachineId,
        createdAt: v.createdAt,
      })),
    };
  },

  async destroyVolume(app: string, volumeId: string): Promise<void> {
    await flyInstancesClient.destroyVolume(flyInstancesConfig(), app, volumeId);
  },

  async destroyMachine(app: string, machineId: string): Promise<void> {
    await flyInstancesClient.destroyMachine(flyInstancesConfig(), app, machineId);
  },

  async exec(
    handle: PersistentContainerHandle,
    command: readonly string[],
    options: { timeoutSeconds?: number } = {},
  ): Promise<PersistentExecResult> {
    return flyInstancesClient.exec(
      flyInstancesConfig(),
      handle.app,
      handle.machineId,
      command,
      options.timeoutSeconds ?? 120,
    );
  },
};
