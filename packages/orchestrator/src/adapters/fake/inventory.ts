import { OrchestratorApiError } from '../../errors';
import type { FleetInventory, InventoryMachine, PersistentContainerState } from '../../types';
import { fakeOrchestrator } from './index';
import { fakePersistentOrchestrator } from './persistent';

// THE FAKE FLEET INVENTORY (MOTIR-6925) — the provider's view over BOTH fakes,
// so the reconciler sees exactly what the fake orchestrators booted: the
// ephemeral fake's containers in one fleet app, and each organisation's instance
// app from the persistent fake. A test adds what no record names with
// {@link FakeInventoryControls.addStray}: a machine started by hand, a leak in an
// app nothing in Motir created.

/** The fake fleet app's name — where the ephemeral fake's containers live. */
export const FAKE_FLEET_APP = 'fake-fleet';

export interface FakeInventoryControls {
  /** Forget every stray machine and every arranged listing failure. */
  reset(): void;
  /** A machine the provider runs that no fake booted. */
  addStray(machine: {
    app: string;
    machineId: string;
    createdAt: Date | null;
    name?: string;
    state?: PersistentContainerState;
    metadata?: Record<string, string>;
  }): void;
  /** Stray machines still on the "provider". */
  strayMachineIds(): string[];
  /** Make the next app list throw. */
  failNextAppList(detail?: string): void;
  /** Make the next machine list of `app` throw. */
  failNextMachineList(app: string, detail?: string): void;
  /** Make the next destroy of `machineId` throw. */
  failNextDestroy(machineId: string, detail?: string): void;
  /** Every destroy and stop, in order — `destroy:<app>/<id>`, `stop:<app>/<id>`. */
  readonly actions: string[];
}

const strays = new Map<string, InventoryMachine>();
const actions: string[] = [];
let appListFailure: string | null = null;
const machineListFailures = new Map<string, string>();
const destroyFailures = new Map<string, string>();

function ephemeralState(state: string): PersistentContainerState {
  if (state === 'created') return 'starting';
  if (state === 'destroyed') return 'gone';
  return 'running';
}

export const fakeFleetInventory: FleetInventory & FakeInventoryControls = {
  provider: 'fake',
  actions,

  reset() {
    strays.clear();
    actions.length = 0;
    appListFailure = null;
    machineListFailures.clear();
    destroyFailures.clear();
  },

  addStray(machine) {
    strays.set(machine.machineId, {
      app: machine.app,
      machineId: machine.machineId,
      name: machine.name ?? '',
      region: 'iad',
      state: machine.state ?? 'running',
      createdAt: machine.createdAt,
      metadata: machine.metadata ?? {},
    });
  },

  strayMachineIds() {
    return [...strays.keys()];
  },

  failNextAppList(detail = 'the fake refused to list apps') {
    appListFailure = detail;
  },

  failNextMachineList(app, detail = 'the fake refused to list machines') {
    machineListFailures.set(app, detail);
  },

  failNextDestroy(machineId, detail = 'the fake refused to destroy') {
    destroyFailures.set(machineId, detail);
  },

  async listApps(): Promise<string[]> {
    if (appListFailure !== null) {
      const detail = appListFailure;
      appListFailure = null;
      throw new OrchestratorApiError('fake', 500, detail);
    }
    const apps = new Set<string>([FAKE_FLEET_APP, ...fakePersistentOrchestrator.appNames()]);
    for (const stray of strays.values()) apps.add(stray.app);
    return [...apps].sort();
  },

  async listMachines(app: string): Promise<InventoryMachine[]> {
    const refused = machineListFailures.get(app);
    if (refused !== undefined) {
      machineListFailures.delete(app);
      throw new OrchestratorApiError('fake', 500, refused);
    }
    const listed: InventoryMachine[] =
      app === FAKE_FLEET_APP
        ? fakeOrchestrator.inventoryMachines().map((m) => ({
            app,
            machineId: m.id,
            name: m.name,
            region: m.region,
            state: ephemeralState(m.state),
            createdAt: m.createdAt,
            metadata: {},
          }))
        : (await fakePersistentOrchestrator.listPersistent(app)).machines.map((m) => ({
            app,
            machineId: m.machineId,
            name: `instance-${m.instanceId ?? m.machineId}`,
            region: 'iad',
            state: m.state,
            createdAt: m.createdAt,
            metadata: {},
          }));
    return [...listed, ...[...strays.values()].filter((s) => s.app === app)];
  },

  async destroyMachine(app: string, machineId: string): Promise<void> {
    const refused = destroyFailures.get(machineId);
    if (refused !== undefined) {
      destroyFailures.delete(machineId);
      throw new OrchestratorApiError('fake', 500, refused);
    }
    actions.push(`destroy:${app}/${machineId}`);
    if (strays.delete(machineId)) return;
    if (app === FAKE_FLEET_APP) {
      fakeOrchestrator.destroyOutsideTeardown(machineId);
      return;
    }
    await fakePersistentOrchestrator.destroyMachine(app, machineId);
  },

  async stopMachine(app: string, machineId: string): Promise<void> {
    actions.push(`stop:${app}/${machineId}`);
    const stray = strays.get(machineId);
    if (stray) {
      strays.set(machineId, { ...stray, state: 'stopped' });
      return;
    }
    await fakePersistentOrchestrator.stop({
      provider: 'fake',
      app,
      machineId,
      volumeId: '',
      region: '',
      createdAt: new Date(),
    });
  },
};
