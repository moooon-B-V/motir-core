import { beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_FLEET_APP,
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  fakeFleetInventory as inventory,
  fakeOrchestrator,
  fakePersistentOrchestrator,
} from '../src/index';

// The FAKE FLEET INVENTORY (MOTIR-6925) — the provider's view over both fakes,
// plus the strays a test adds for what no record names.

async function bootEphemeral() {
  return fakeOrchestrator.provision({
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'p-1',
    repoFullName: 'acme/web',
    workload: 'ci_runner',
    workflowJobId: 1,
    image: 'runner@sha256:x',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    timeoutSeconds: 60,
    region: 'iad',
  });
}

async function bootPersistent() {
  return fakePersistentOrchestrator.provisionPersistent({
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'p-1',
    instanceId: 'inst-1',
    image: 'sandbox@sha256:x',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    region: 'iad',
    volumeSizeGb: 10,
    mountPath: '/home/node',
    terminal: null,
  });
}

beforeEach(() => {
  inventory.reset();
  fakeOrchestrator.reset();
  fakePersistentOrchestrator.reset();
});

describe('the fake fleet inventory', () => {
  it('lists the fleet app, every instance app and every stray app', async () => {
    const persistent = await bootPersistent();
    inventory.addStray({ app: 'elsewhere', machineId: 'm-s', createdAt: null });
    expect(await inventory.listApps()).toEqual(
      [FAKE_FLEET_APP, persistent.app, 'elsewhere'].sort(),
    );
  });

  it('lists the ephemeral fake in the fleet app, the persistent fake in its app, and strays', async () => {
    const ephemeral = await bootEphemeral();
    const persistent = await bootPersistent();
    inventory.addStray({
      app: FAKE_FLEET_APP,
      machineId: 'm-s',
      createdAt: null,
      name: 'by-hand',
      state: 'stopped',
      metadata: { motir_org_id: 'org-1' },
    });

    expect(await inventory.listMachines(FAKE_FLEET_APP)).toEqual([
      {
        app: FAKE_FLEET_APP,
        machineId: ephemeral.id,
        name: `fake-ci_runner-${ephemeral.id}`,
        region: 'iad',
        state: 'running',
        createdAt: ephemeral.createdAt,
        metadata: {},
      },
      {
        app: FAKE_FLEET_APP,
        machineId: 'm-s',
        name: 'by-hand',
        region: 'iad',
        state: 'stopped',
        createdAt: null,
        metadata: { motir_org_id: 'org-1' },
      },
    ]);
    expect(await inventory.listMachines(persistent.app)).toMatchObject([
      { machineId: persistent.machineId, name: 'instance-inst-1', state: 'running' },
    ]);
  });

  it('maps an ephemeral machine that never started to starting', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');
    await bootEphemeral();
    expect((await inventory.listMachines(FAKE_FLEET_APP))[0]!.state).toBe('starting');
  });

  it('destroys a stray, an ephemeral machine and a persistent one — each once', async () => {
    const ephemeral = await bootEphemeral();
    const persistent = await bootPersistent();
    inventory.addStray({ app: 'elsewhere', machineId: 'm-s', createdAt: new Date() });

    await inventory.destroyMachine('elsewhere', 'm-s');
    await inventory.destroyMachine(FAKE_FLEET_APP, ephemeral.id);
    await inventory.destroyMachine(FAKE_FLEET_APP, ephemeral.id);
    await inventory.destroyMachine(persistent.app, persistent.machineId);

    expect(inventory.strayMachineIds()).toEqual([]);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakePersistentOrchestrator.liveMachineIds()).toEqual([]);
    expect(inventory.actions).toEqual([
      'destroy:elsewhere/m-s',
      `destroy:${FAKE_FLEET_APP}/${ephemeral.id}`,
      `destroy:${FAKE_FLEET_APP}/${ephemeral.id}`,
      `destroy:${persistent.app}/${persistent.machineId}`,
    ]);
  });

  it('stops a stray and a persistent machine', async () => {
    const persistent = await bootPersistent();
    inventory.addStray({ app: 'elsewhere', machineId: 'm-s', createdAt: new Date() });

    await inventory.stopMachine('elsewhere', 'm-s');
    await inventory.stopMachine(persistent.app, persistent.machineId);

    expect((await inventory.listMachines('elsewhere'))[0]!.state).toBe('stopped');
    expect((await inventory.listMachines(persistent.app))[0]!.state).toBe('stopped');
  });

  it('arms one failure per call, then answers again', async () => {
    inventory.failNextAppList();
    await expect(inventory.listApps()).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(await inventory.listApps()).toEqual([FAKE_FLEET_APP]);

    inventory.failNextMachineList('a');
    await expect(inventory.listMachines('a')).rejects.toThrow(/refused to list machines/);
    expect(await inventory.listMachines('a')).toEqual([]);

    inventory.addStray({ app: 'a', machineId: 'm-1', createdAt: new Date() });
    inventory.failNextDestroy('m-1');
    await expect(inventory.destroyMachine('a', 'm-1')).rejects.toThrow(/refused to destroy/);
    await inventory.destroyMachine('a', 'm-1');
    expect(inventory.strayMachineIds()).toEqual([]);
  });

  it('the ephemeral fake destroys outside a teardown idempotently', async () => {
    fakeOrchestrator.destroyOutsideTeardown('never-booted');
    const ephemeral = await bootEphemeral();
    fakeOrchestrator.destroyOutsideTeardown(ephemeral.id);
    fakeOrchestrator.destroyOutsideTeardown(ephemeral.id);
    expect(fakeOrchestrator.inventoryMachines()).toEqual([]);
  });
});
