import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrchestratorApiError } from '../../errors';
import type {
  PersistentAppInventory,
  PersistentContainerHandle,
  PersistentContainerOrchestrator,
  PersistentContainerSpec,
  PersistentContainerState,
  PersistentContainerStatus,
  PersistentExecResult,
} from '../../types';

// The FAKE adapter's PERSISTENT half (Story MOTIR-6860 · MOTIR-6869) — the
// second implementation of the persistent port, shipped beside the Fly one for
// the reason `./index.ts` gives: a port with one implementation has never been
// shown to be a port. The lifecycle service's tests, the story's seam gate and
// its E2E drive it; none of them can boot a real machine.
//
// It models exactly what the decision relies on (§1, §2): a machine that STOPS
// rather than disappears, a volume that survives the machine, every start a new
// run with its own start instant, and a destroy that takes the machine and then
// the volume. Its controls reach the cases a test must be able to arrange: a
// provider refusal, a start that fails (no capacity on the volume's host), a
// machine destroyed OUTSIDE Motir, a machine stopped behind Motir's back, and a
// clock.
//
// ⚠️ A MODULE SINGLETON, with an OPT-IN file-backed store — the same
// cross-process seam `./index.ts` documents (MOTIR-3828) and for the same
// reason: the E2E lane's web server provisions and its worker sweeps, so the
// two processes must see one fleet. Absent the variable it is an in-memory map.

interface FakePersistentMachine {
  handle: PersistentContainerHandle;
  spec: PersistentContainerSpec;
  state: PersistentContainerState;
  startedAt: string | null;
  stoppedAt: string | null;
  starts: number;
}

interface FakeStore {
  apps: string[];
  machines: Record<string, FakePersistentMachine>;
  volumes: Record<
    string,
    { app: string; name: string; attachedMachineId: string | null; createdAt: string }
  >;
  sequence: number;
}

export interface FakePersistentControls {
  /** Forget every app, machine and volume and every arranged failure. */
  reset(): void;
  /** Make the next `provisionPersistent` throw BEFORE anything is created. */
  failNextProvision(detail?: string): void;
  /** Make the next `provisionPersistent` create the volume and then fail the MACHINE create. */
  failNextMachineCreate(detail?: string): void;
  /** Make the next `start` throw — the volume's host has no capacity. */
  failNextStart(detail?: string): void;
  /** Make the next `stop` throw. */
  failNextStop(detail?: string): void;
  /** Make the next `destroyPersistent` throw. */
  failNextDestroy(detail?: string): void;
  /** New machines boot `running` (default) or stay `starting` until {@link completeBoot}. */
  setBootBehaviour(behaviour: 'start' | 'never_start'): void;
  /** Move a `starting` machine to `running`, stamping its run's start. */
  completeBoot(machineId: string): void;
  /** The machine vanished outside Motir (destroyed in the console, host lost). Its volume stays. */
  destroyOutside(machineId: string): void;
  /** The machine stopped behind Motir's back (a crash with no restart, an operator). */
  stopOutside(machineId: string): void;
  /** Move the current run's start earlier, so a charge covers measurable seconds. */
  backdateRun(machineId: string, startedAt: Date): void;
  /** The clock every instant is read from. */
  setNow(now: () => Date): void;
  /** Machines that still exist, stopped or not. */
  liveMachineIds(): string[];
  /** Volumes that still exist. */
  liveVolumeIds(): string[];
  /** Apps created so far — one per organisation. */
  appNames(): string[];
  /** Every spec `provisionPersistent` was asked for, in order. */
  readonly persistentSpecs: PersistentContainerSpec[];
  /** Every operation, in order — how a test asserts the SEQUENCE (machine before volume). */
  readonly operations: string[];
  /** Every `exec` command, in order, with the machine it ran on. */
  readonly execs: Array<{ machineId: string; command: string[] }>;
  /** What the next `exec` returns (default: exit 0, empty output). */
  setNextExecResult(result: PersistentExecResult): void;
}

const STATE_PATH_ENV = 'MOTIR_FAKE_PERSISTENT_STATE_PATH';

let store: FakeStore = { apps: [], machines: {}, volumes: {}, sequence: 0 };
const persistentSpecs: PersistentContainerSpec[] = [];
const operations: string[] = [];
const execs: Array<{ machineId: string; command: string[] }> = [];
let nextExec: PersistentExecResult | null = null;
type FailureKind = 'provision' | 'machine' | 'start' | 'stop' | 'destroy';
const failures: Record<FailureKind, string | null> = {
  provision: null,
  machine: null,
  start: null,
  stop: null,
  destroy: null,
};
let bootBehaviour: 'start' | 'never_start' = 'start';
let now: () => Date = () => new Date();

function statePath(): string | null {
  const raw = process.env[STATE_PATH_ENV];
  return raw !== undefined && raw !== '' ? raw : null;
}

function load(): void {
  const path = statePath();
  if (!path || !existsSync(path)) return;
  try {
    store = JSON.parse(readFileSync(path, 'utf8')) as FakeStore;
  } catch {
    // A torn read; keep what this process has — the next write replaces it.
  }
}

function save(): void {
  const path = statePath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), 'utf8');
}

/**
 * Arranged failures also live in a SIDECAR beside a shared state file, so another
 * process sharing the fleet sees them — an E2E runner arms a failure the web
 * server then meets. A sidecar, not a field of the store: reading one must never
 * reload the store mid-operation.
 */
function failuresPath(): string | null {
  const path = statePath();
  return path ? `${path}.failures.json` : null;
}

function readSharedFailures(): Partial<Record<FailureKind, string>> {
  const path = failuresPath();
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<FailureKind, string>>;
  } catch {
    return {};
  }
}

function writeSharedFailures(value: Partial<Record<FailureKind, string>>): void {
  const path = failuresPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

function takeFailure(kind: FailureKind): string | null {
  const shared = readSharedFailures();
  const detail = failures[kind] ?? shared[kind] ?? null;
  failures[kind] = null;
  if (shared[kind] !== undefined) {
    delete shared[kind];
    writeSharedFailures(shared);
  }
  return detail;
}

/** Arm one failure in memory and, when a state file is shared, in its sidecar. */
function armFailure(kind: FailureKind, detail: string): void {
  failures[kind] = detail;
  if (failuresPath()) writeSharedFailures({ ...readSharedFailures(), [kind]: detail });
}

function nextId(prefix: string): string {
  store.sequence += 1;
  return statePath() ? `${prefix}-${process.pid}-${store.sequence}` : `${prefix}-${store.sequence}`;
}

function machineOrThrow(machineId: string): FakePersistentMachine {
  load();
  const machine = store.machines[machineId];
  if (!machine) throw new Error(`fake persistent orchestrator has no machine ${machineId}`);
  return machine;
}

export const fakePersistentOrchestrator: PersistentContainerOrchestrator & FakePersistentControls =
  {
    provider: 'fake',
    persistentSpecs,
    operations,
    execs,

    // ── controls ──────────────────────────────────────────────────────────────

    reset() {
      store = { apps: [], machines: {}, volumes: {}, sequence: 0 };
      save();
      persistentSpecs.length = 0;
      operations.length = 0;
      execs.length = 0;
      nextExec = null;
      execs.length = 0;
      nextExec = null;
      for (const key of Object.keys(failures) as Array<keyof typeof failures>) failures[key] = null;
      writeSharedFailures({});
      bootBehaviour = 'start';
      now = () => new Date();
    },
    failNextProvision(detail = 'the fake refused to provision') {
      armFailure('provision', detail);
    },
    failNextMachineCreate(detail = 'the fake refused to create the machine') {
      armFailure('machine', detail);
    },
    failNextStart(detail = 'no capacity on the volume host') {
      armFailure('start', detail);
    },
    failNextStop(detail = 'the fake refused to stop') {
      armFailure('stop', detail);
    },
    failNextDestroy(detail = 'the fake refused to destroy') {
      armFailure('destroy', detail);
    },
    setBootBehaviour(behaviour) {
      bootBehaviour = behaviour;
    },
    completeBoot(machineId) {
      const machine = machineOrThrow(machineId);
      if (machine.state === 'starting') {
        machine.state = 'running';
        machine.startedAt = now().toISOString();
        machine.stoppedAt = null;
      }
      save();
    },
    destroyOutside(machineId) {
      load();
      delete store.machines[machineId];
      for (const volume of Object.values(store.volumes)) {
        if (volume.attachedMachineId === machineId) volume.attachedMachineId = null;
      }
      save();
    },
    stopOutside(machineId) {
      const machine = machineOrThrow(machineId);
      machine.state = 'stopped';
      machine.stoppedAt = now().toISOString();
      save();
    },
    backdateRun(machineId, startedAt) {
      const machine = machineOrThrow(machineId);
      machine.startedAt = startedAt.toISOString();
      save();
    },
    setNow(next) {
      now = next;
    },
    setNextExecResult(result) {
      nextExec = result;
    },
    liveMachineIds() {
      load();
      return Object.keys(store.machines);
    },
    liveVolumeIds() {
      load();
      return Object.keys(store.volumes);
    },
    appNames() {
      load();
      return [...store.apps];
    },

    // ── the port ──────────────────────────────────────────────────────────────

    appNameFor(orgId: string): string {
      return `fake-inst-${orgId}`;
    },

    defaultRegion(): string {
      return 'iad';
    },

    async provisionPersistent(spec: PersistentContainerSpec): Promise<PersistentContainerHandle> {
      load();
      persistentSpecs.push(spec);
      const refused = takeFailure('provision');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);

      const app = this.appNameFor(spec.orgId);
      if (!store.apps.includes(app)) {
        store.apps.push(app);
        operations.push(`app:create:${app}`);
      }
      const volumeId = nextId('fake-volume');
      store.volumes[volumeId] = {
        app,
        name: `home_${spec.instanceId}`,
        attachedMachineId: null,
        createdAt: now().toISOString(),
      };
      operations.push(`volume:create:${volumeId}`);

      const machineRefused = takeFailure('machine');
      if (machineRefused) {
        // The Fly adapter's rule: a volume whose machine never came is destroyed
        // before the throw, because nobody else will ever hold its id.
        delete store.volumes[volumeId];
        operations.push(`volume:destroy:${volumeId}`);
        save();
        throw new OrchestratorApiError('fake', 500, machineRefused);
      }

      const machineId = nextId('fake-instance');
      const createdAt = now();
      const handle: PersistentContainerHandle = {
        provider: 'fake',
        app,
        machineId,
        volumeId,
        region: spec.region,
        createdAt,
      };
      const boots = bootBehaviour === 'start';
      store.machines[machineId] = {
        handle,
        spec,
        state: boots ? 'running' : 'starting',
        startedAt: boots ? createdAt.toISOString() : null,
        stoppedAt: null,
        starts: 1,
      };
      store.volumes[volumeId]!.attachedMachineId = machineId;
      operations.push(`machine:create:${machineId}`);
      save();
      return handle;
    },

    async stop(handle: PersistentContainerHandle): Promise<void> {
      load();
      const refused = takeFailure('stop');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);
      const machine = store.machines[handle.machineId];
      operations.push(`machine:stop:${handle.machineId}`);
      // Idempotent: a stopped machine stays stopped; a gone one is an answer.
      if (!machine || machine.state === 'stopped') return;
      machine.state = 'stopped';
      machine.stoppedAt = now().toISOString();
      save();
    },

    async start(handle: PersistentContainerHandle): Promise<void> {
      load();
      const refused = takeFailure('start');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);
      const machine = store.machines[handle.machineId];
      if (!machine)
        throw new OrchestratorApiError('fake', 404, `machine ${handle.machineId} is gone`);
      operations.push(`machine:start:${handle.machineId}`);
      if (machine.state === 'running') return;
      // Every start is a new run: its own start instant, no stop yet.
      machine.state = bootBehaviour === 'start' ? 'running' : 'starting';
      machine.startedAt = bootBehaviour === 'start' ? now().toISOString() : null;
      machine.stoppedAt = null;
      machine.starts += 1;
      save();
    },

    async describePersistent(
      handle: PersistentContainerHandle,
    ): Promise<PersistentContainerStatus> {
      load();
      const machine = store.machines[handle.machineId];
      if (!machine) {
        return {
          machineId: handle.machineId,
          state: 'gone',
          providerState: '',
          startedAt: null,
          stoppedAt: null,
        };
      }
      return {
        machineId: handle.machineId,
        state: machine.state,
        providerState: machine.state,
        startedAt: machine.startedAt ? new Date(machine.startedAt) : null,
        stoppedAt: machine.stoppedAt ? new Date(machine.stoppedAt) : null,
      };
    },

    async destroyPersistent(handle: PersistentContainerHandle): Promise<void> {
      load();
      const refused = takeFailure('destroy');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);
      if (store.machines[handle.machineId]) {
        delete store.machines[handle.machineId];
        operations.push(`machine:destroy:${handle.machineId}`);
      }
      if (store.volumes[handle.volumeId]) {
        delete store.volumes[handle.volumeId];
        operations.push(`volume:destroy:${handle.volumeId}`);
      }
      save();
    },

    async listPersistent(app: string): Promise<PersistentAppInventory> {
      load();
      return {
        app,
        machines: Object.values(store.machines)
          .filter((m) => m.handle.app === app)
          .map((m) => ({
            machineId: m.handle.machineId,
            state: m.state,
            instanceId: m.spec.instanceId,
            createdAt:
              m.handle.createdAt instanceof Date
                ? m.handle.createdAt
                : new Date(m.handle.createdAt),
          })),
        volumes: Object.entries(store.volumes)
          .filter(([, v]) => v.app === app)
          .map(([volumeId, v]) => ({
            volumeId,
            name: v.name,
            attachedMachineId: v.attachedMachineId,
            createdAt: new Date(v.createdAt),
          })),
      };
    },

    async destroyVolume(_app: string, volumeId: string): Promise<void> {
      load();
      if (store.volumes[volumeId]) {
        delete store.volumes[volumeId];
        operations.push(`volume:destroy:${volumeId}`);
      }
      save();
    },

    async exec(
      handle: PersistentContainerHandle,
      command: readonly string[],
    ): Promise<PersistentExecResult> {
      load();
      const machine = store.machines[handle.machineId];
      if (!machine || machine.state !== 'running') {
        throw new OrchestratorApiError('fake', 412, `machine ${handle.machineId} is not running`);
      }
      execs.push({ machineId: handle.machineId, command: [...command] });
      operations.push(`machine:exec:${handle.machineId}`);
      const result = nextExec ?? { exitCode: 0, stdout: '', stderr: '' };
      nextExec = null;
      return result;
    },

    async destroyMachine(_app: string, machineId: string): Promise<void> {
      load();
      if (store.machines[machineId]) {
        delete store.machines[machineId];
        operations.push(`machine:destroy:${machineId}`);
        for (const volume of Object.values(store.volumes)) {
          if (volume.attachedMachineId === machineId) volume.attachedMachineId = null;
        }
      }
      save();
    },
  };
