import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  fakePersistentOrchestrator as fake,
  type PersistentContainerSpec,
} from '../src/index';

// The FAKE persistent adapter (Story MOTIR-6860 · MOTIR-6869) — the second
// implementation of the persistent port. These pin the behaviours the lifecycle
// service and the story's gates rely on it to model (§1, §2).

const SPEC: PersistentContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  instanceId: 'inst-1',
  image: 'ghcr.io/moooon-b-v/motir-sandbox@sha256:' + 'c'.repeat(64),
  size: FLEET_CONTAINER_SIZE,
  env: {},
  region: 'iad',
  volumeSizeGb: 10,
  mountPath: '/home/node',
};

beforeEach(() => fake.reset());

describe('fakePersistentOrchestrator', () => {
  it('provisions an app once per org, a volume, then a running machine mounting it', async () => {
    const a = await fake.provisionPersistent(SPEC);
    const b = await fake.provisionPersistent({ ...SPEC, instanceId: 'inst-2' });
    expect(a.app).toBe(fake.appNameFor('org-1'));
    expect(fake.defaultRegion()).toBe('iad');
    expect(fake.appNames()).toEqual([a.app]);
    expect(fake.operations).toEqual([
      `app:create:${a.app}`,
      `volume:create:${a.volumeId}`,
      `machine:create:${a.machineId}`,
      `volume:create:${b.volumeId}`,
      `machine:create:${b.machineId}`,
    ]);
    expect(fake.persistentSpecs).toHaveLength(2);
    expect((await fake.describePersistent(a)).state).toBe('running');
    expect(fake.liveVolumeIds()).toEqual([a.volumeId, b.volumeId]);
  });

  it('a refused provision creates nothing; a refused MACHINE create destroys its volume', async () => {
    fake.failNextProvision();
    await expect(fake.provisionPersistent(SPEC)).rejects.toThrow(OrchestratorApiError);
    expect(fake.liveVolumeIds()).toEqual([]);
    fake.failNextMachineCreate();
    await expect(fake.provisionPersistent(SPEC)).rejects.toThrow(OrchestratorApiError);
    expect(fake.liveVolumeIds()).toEqual([]);
    expect(fake.liveMachineIds()).toEqual([]);
  });

  it('stop keeps the volume and records the stop; start is a NEW run with its own start instant', async () => {
    let clock = new Date('2026-09-28T10:00:00.000Z');
    fake.setNow(() => clock);
    const h = await fake.provisionPersistent(SPEC);
    clock = new Date('2026-09-28T10:30:00.000Z');
    await fake.stop(h);
    await fake.stop(h); // idempotent
    const stopped = await fake.describePersistent(h);
    expect(stopped).toMatchObject({ state: 'stopped' });
    expect(stopped.stoppedAt?.toISOString()).toBe('2026-09-28T10:30:00.000Z');
    expect(fake.liveVolumeIds()).toEqual([h.volumeId]);

    clock = new Date('2026-09-28T12:00:00.000Z');
    await fake.start(h);
    await fake.start(h); // idempotent while running
    const woken = await fake.describePersistent(h);
    expect(woken.state).toBe('running');
    expect(woken.startedAt?.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(woken.stoppedAt).toBeNull();
  });

  it('a start can fail (no capacity), and a start of a gone machine throws', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.stop(h);
    fake.failNextStart();
    await expect(fake.start(h)).rejects.toThrow(/capacity/);
    fake.destroyOutside(h.machineId);
    await expect(fake.start(h)).rejects.toThrow(/gone/);
    await expect(fake.stop(h)).resolves.toBeUndefined();
    fake.failNextStop();
    await expect(fake.stop(h)).rejects.toThrow(OrchestratorApiError);
  });

  it('models a machine that never boots, completes it, and one stopped or destroyed outside Motir', async () => {
    fake.setBootBehaviour('never_start');
    const h = await fake.provisionPersistent(SPEC);
    expect((await fake.describePersistent(h)).state).toBe('starting');
    await fake.stop(h);
    await fake.start(h);
    expect((await fake.describePersistent(h)).state).toBe('starting');
    fake.completeBoot(h.machineId);
    expect((await fake.describePersistent(h)).state).toBe('running');
    fake.completeBoot(h.machineId); // no-op once running

    fake.backdateRun(h.machineId, new Date('2026-09-28T08:00:00.000Z'));
    expect((await fake.describePersistent(h)).startedAt?.toISOString()).toBe(
      '2026-09-28T08:00:00.000Z',
    );
    fake.stopOutside(h.machineId);
    expect((await fake.describePersistent(h)).state).toBe('stopped');
    fake.destroyOutside(h.machineId);
    expect(await fake.describePersistent(h)).toMatchObject({ state: 'gone', startedAt: null });
    // The volume survives the machine and is now unattached — the reconcile's orphan.
    const inventory = await fake.listPersistent(h.app);
    expect(inventory.machines).toEqual([]);
    expect(inventory.volumes).toEqual([
      expect.objectContaining({ volumeId: h.volumeId, attachedMachineId: null }),
    ]);
    expect(() => fake.completeBoot('nope')).toThrow(/no machine/);
  });

  it('destroyPersistent takes the machine THEN the volume, idempotently', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.destroyPersistent(h);
    await fake.destroyPersistent(h);
    expect(fake.operations.slice(-2)).toEqual([
      `machine:destroy:${h.machineId}`,
      `volume:destroy:${h.volumeId}`,
    ]);
    expect(fake.liveMachineIds()).toEqual([]);
    expect(fake.liveVolumeIds()).toEqual([]);
    fake.failNextDestroy();
    await expect(fake.destroyPersistent(h)).rejects.toThrow(OrchestratorApiError);
  });

  it('lists one app’s inventory and destroys orphans by id', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.provisionPersistent({ ...SPEC, orgId: 'org-2', instanceId: 'other' });
    const inventory = await fake.listPersistent(h.app);
    expect(inventory.machines).toEqual([
      expect.objectContaining({ machineId: h.machineId, state: 'running', instanceId: 'inst-1' }),
    ]);
    expect(inventory.volumes).toHaveLength(1);
    await fake.destroyMachine(h.app, h.machineId);
    await fake.destroyMachine(h.app, h.machineId);
    await fake.destroyVolume(h.app, h.volumeId);
    await fake.destroyVolume(h.app, h.volumeId);
    expect(await fake.listPersistent(h.app)).toEqual({ app: h.app, machines: [], volumes: [] });
  });
});

describe('the cross-process seam', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-persistent-'));
    vi.stubEnv('MOTIR_FAKE_PERSISTENT_STATE_PATH', join(dir, 'state.json'));
    fake.reset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the fleet to the shared file, so another process sees the same machines', async () => {
    const h = await fake.provisionPersistent(SPEC);
    expect(h.machineId).toMatch(new RegExp(`^fake-instance-${process.pid}-`));
    const inventory = await fake.listPersistent(h.app);
    expect(inventory.machines[0]!.createdAt).toBeInstanceOf(Date);
    expect(fake.liveMachineIds()).toEqual([h.machineId]);
  });
});

describe('exec (MOTIR-6872)', () => {
  it('records each command on a running machine and returns the arranged result once', async () => {
    const h = await fake.provisionPersistent(SPEC);
    expect(await fake.exec(h, ['echo', 'hi'])).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    fake.setNextExecResult({ exitCode: 128, stdout: '', stderr: 'fatal' });
    expect((await fake.exec(h, ['git', 'clone'])).exitCode).toBe(128);
    expect((await fake.exec(h, ['true'])).exitCode).toBe(0);
    expect(fake.execs.map((e) => e.command[0])).toEqual(['echo', 'git', 'true']);
  });

  it('refuses a machine that is not running', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.stop(h);
    await expect(fake.exec(h, ['true'])).rejects.toThrow(/not running/);
    fake.destroyOutside(h.machineId);
    await expect(fake.exec(h, ['true'])).rejects.toThrow(/not running/);
  });
});
