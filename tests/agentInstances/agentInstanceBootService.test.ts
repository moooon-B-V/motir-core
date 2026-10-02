import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { AGENT_BOOT_LEASE_MS, INSTANCE_BOOT_DEADLINE_MS } from '@/lib/agentInstances/config';
import { AGENT_TERMINAL_PROBE_COMMAND } from '@/lib/agentInstances/terminal';
import { agentInstanceBootService as boot } from '@/lib/services/agentInstanceBootService';
import {
  agentInstanceBootSteps,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import {
  clock,
  fleet,
  fx,
  intervals,
  seedRepo,
  setUpHarness,
  slots,
  tearDownHarness,
} from './_harness';

// THE BOOT DRIVER (Story MOTIR-7393 · MOTIR-7398, `agent-instances.md` AMENDMENT 6
// §3–§4) over the real services, a real Postgres and the fake persistent fleet:
// each step recorded in order, a failure on each step, the wake's skipped clones,
// the lease's single flight, a crashed pass resumed, and a delete mid-boot.
//
// The attempt is OPENED here the way create and wake open it (the opener's write,
// §5): `start` inside a transaction, then `recordProvision`. The agent itself is
// created through the lifecycle with a machine that does not start on its own,
// so nothing but the driver moves it out of `starting`.

beforeEach(async () => {
  await setUpHarness();
  await seedRepo('acme', 'web');
  await seedRepo('acme', 'api');
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const agentRow = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

async function startingAgent(name = 'yue-claude'): Promise<AgentInstance> {
  fleet.setBootBehaviour('never_start');
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('starting');
  return agentRow(dto.id);
}

async function open(row: AgentInstance, kind: 'create' | 'wake' = 'create'): Promise<number> {
  const { attempt, event } = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    boot.start(row, kind, tx),
  );
  expect(event).toEqual({
    workspaceId: row.workspaceId,
    instanceId: row.id,
    attempt,
    idempotencyKey: `agent-instance-boot:${row.id}:${attempt}`,
  });
  await boot.recordProvision(row, attempt, null);
  return attempt;
}

const stepsOf = async (agentInstanceId: string, attempt: number) => {
  const a = await adminDb.agentInstanceBootAttempt.findUniqueOrThrow({
    where: { agentInstanceId_attempt: { agentInstanceId, attempt } },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  });
  return a;
};
const shape = (rows: Array<{ step: string; repository: string | null; state: string }>) =>
  rows.map((s) => [s.step, s.repository, s.state]);
const maxSeq = async (agentInstanceId: string) =>
  (
    await adminDb.agentInstanceBootStep.aggregate({
      where: { bootAttempt: { agentInstanceId } },
      _max: { seq: true },
    })
  )._max.seq ?? 0;
const cloneExecs = () => fleet.execs.filter((e) => e.command.includes('motir-clone'));

describe('one create attempt, driven pass by pass', () => {
  it('records every step in order and ends running, with the interval on the machine’s start', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    expect(shape((await stepsOf(row.id, attempt)).steps)).toEqual([
      ['provision', null, 'done'],
      ['machine_start', null, 'waiting'],
      ['clone', 'acme/web', 'waiting'],
      ['clone', 'acme/api', 'waiting'],
      ['terminal_check', null, 'waiting'],
      ['ready', null, 'waiting'],
    ]);

    const first = await boot.advance(row.id, attempt, 'run-1');
    expect(first).toMatchObject({ next: 'defer' });
    expect(shape((await stepsOf(row.id, attempt)).steps)[1]).toEqual([
      'machine_start',
      null,
      'in_progress',
    ]);
    expect(cloneExecs()).toEqual([]);

    clock.advance(5_000);
    fleet.completeBoot(row.machineId!);
    const startedAt = clock.now();
    clock.advance(1_000);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });

    const after = await stepsOf(row.id, attempt);
    expect(shape(after.steps)).toEqual([
      ['provision', null, 'done'],
      ['machine_start', null, 'done'],
      ['clone', 'acme/web', 'done'],
      ['clone', 'acme/api', 'done'],
      // The terminal is off on this deployment: the probes are not asked.
      ['terminal_check', null, 'skipped'],
      ['ready', null, 'done'],
    ]);
    expect(after.steps[1]!.endedAt).toEqual(startedAt);
    expect(after).toMatchObject({ outcome: 'running', leaseHolder: null, leaseExpiresAt: null });
    // ONE exec per repository, in the project's order.
    expect(cloneExecs().map((e) => e.command.at(-1))).toEqual(['acme/web', 'acme/api']);

    const agent = await agentRow(row.id);
    expect(agent.state).toBe('running');
    const openInterval = (await intervals()).find((i) => i.endedAt === null)!;
    expect(openInterval.startedAt).toEqual(startedAt);
    // The idle timer is armed, exactly as `settleBoot` arms it.
    const idle = await adminDb.jobQueueRun.findMany({
      where: { jobId: 'agent-instance/idle-check' },
    });
    expect(idle.length).toBeGreaterThan(0);

    // A pass after the end writes nothing.
    const seq = await maxSeq(row.id);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });
    expect(await maxSeq(row.id)).toBe(seq);
  });

  it('records the terminal check with the probe’s answer when the terminal is on', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'm'.repeat(48));
    const row = await startingAgent();
    const attempt = await open(row);
    fleet.completeBoot(row.machineId!);
    await boot.advance(row.id, attempt, 'run-1');
    const terminal = (await stepsOf(row.id, attempt)).steps.find(
      (s) => s.step === 'terminal_check',
    )!;
    expect(terminal).toMatchObject({ state: 'done', detail: 'terminal server present' });
    expect(
      fleet.execs.some((e) => e.command.join(' ') === AGENT_TERMINAL_PROBE_COMMAND.join(' ')),
    ).toBe(true);
  });

  it('a repository already cloned is done without a second clone — the script skips its .git', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    fleet.completeBoot(row.machineId!);
    await boot.advance(row.id, attempt, 'run-1');
    // Every exec is the same idempotent script, one repository each: re-running it
    // on a repository with `.git` is the script's own skip.
    for (const exec of cloneExecs()) {
      expect(exec.command.join('\n')).toContain('if [ -d "$dest/.git" ]; then continue; fi');
      expect(exec.command.filter((a) => a.startsWith('acme/'))).toHaveLength(1);
    }
  });
});

describe('a failure fails its own step, and the agent through failInstance', () => {
  async function expectAgentFailed(id: string, reason: RegExp): Promise<void> {
    const agent = await agentRow(id);
    expect(agent.state).toBe('failed');
    expect(agent.failureReason).toMatch(reason);
    expect((await intervals()).filter((i) => i.endedAt === null)).toEqual([]);
    expect((await intervals()).at(-1)).toMatchObject({ endReason: 'lost' });
    expect(await slots()).toEqual([]);
  }

  it('a provisioning error is provision failed, and the attempt is closed', async () => {
    const row = await startingAgent();
    const { attempt } = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      boot.start(row, 'create', tx),
    );
    await boot.recordProvision(row, attempt, 'no capacity in iad');
    const a = await stepsOf(row.id, attempt);
    expect(a.steps[0]).toMatchObject({
      step: 'provision',
      state: 'failed',
      detail: 'no capacity in iad',
    });
    expect(a.outcome).toBe('failed');
    // The steps after it stay waiting, and a driver writes nothing.
    expect(a.steps.slice(1).every((s) => s.state === 'waiting')).toBe(true);
    const seq = await maxSeq(row.id);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });
    expect(await maxSeq(row.id)).toBe(seq);
  });

  it('a machine that exits with code 0 fails machine_start with its exit code', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    await boot.advance(row.id, attempt, 'run-1');
    clock.advance(30_000);
    fleet.exitOutside(row.machineId!, 0);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });
    const a = await stepsOf(row.id, attempt);
    expect(a.steps[1]).toMatchObject({
      step: 'machine_start',
      state: 'failed',
      detail: 'exit code 0',
    });
    expect(a.steps.slice(2).every((s) => s.state === 'waiting')).toBe(true);
    expect(a.outcome).toBe('failed');
    await expectAgentFailed(row.id, /exited during boot \(exit code 0\)/);
  });

  it('a refused clone of the second repository fails that row with git’s words and no token', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    fleet.setExecResponder((command) =>
      command.includes('acme/api')
        ? {
            exitCode: 128,
            stdout: '',
            stderr: `fatal: could not read from remote (${command[command.indexOf('motir-clone') + 1]})\n`,
          }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
    fleet.completeBoot(row.machineId!);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });
    const a = await stepsOf(row.id, attempt);
    expect(shape(a.steps)).toEqual([
      ['provision', null, 'done'],
      ['machine_start', null, 'done'],
      ['clone', 'acme/web', 'done'],
      ['clone', 'acme/api', 'failed'],
      ['terminal_check', null, 'waiting'],
      ['ready', null, 'waiting'],
    ]);
    const failed = a.steps[3]!;
    expect(failed.detail).toMatch(/^fatal: could not read from remote/);
    expect(failed.detail).not.toMatch(/ghs_|eC1hY2Nlc3Mt/);
    await expectAgentFailed(row.id, /cloning acme\/api failed: fatal/);
    // Every minted token was revoked.
    const { stub } = await import('./_harness');
    expect(stub.calls.filter((c) => c.url.endsWith('/installation/token'))).toHaveLength(1);
  });

  it('the deadline fails the step in progress', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    await boot.advance(row.id, attempt, 'run-1');
    clock.advance(INSTANCE_BOOT_DEADLINE_MS);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });
    expect((await stepsOf(row.id, attempt)).steps[1]).toMatchObject({
      step: 'machine_start',
      state: 'failed',
      detail: 'the machine did not start in time',
    });
    await expectAgentFailed(row.id, /did not finish starting within 10 minutes/);
  });
});

describe('a wake attempt', () => {
  it('records its clone rows skipped and runs no clone', async () => {
    fleet.setBootBehaviour('start');
    const dto = await lifecycle.create(
      fx.projectIdentifier,
      { name: 'yue-claude', profileId: 'claude' },
      fx.ctx,
    );
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    fleet.setBootBehaviour('never_start');
    clock.advance(60_000);
    expect((await lifecycle.wake(fx.projectIdentifier, dto.id, fx.ctx)).state).toBe('waking');
    const row = await agentRow(dto.id);
    const execsBefore = cloneExecs().length;
    const attempt = await open(row, 'wake');
    expect(attempt).toBe(1);
    fleet.completeBoot(row.machineId!);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });
    const a = await stepsOf(row.id, attempt);
    expect(a.kind).toBe('wake');
    expect(shape(a.steps)).toEqual([
      ['provision', null, 'done'],
      ['machine_start', null, 'done'],
      ['clone', 'acme/web', 'skipped'],
      ['clone', 'acme/api', 'skipped'],
      ['terminal_check', null, 'skipped'],
      ['ready', null, 'done'],
    ]);
    expect(cloneExecs()).toHaveLength(execsBefore);
    expect((await agentRow(row.id)).state).toBe('running');
  });
});

describe('one party advances a boot — the lease', () => {
  it('a second holder while the lease is live writes nothing', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    await boot.advance(row.id, attempt, 'run-1');
    const seq = await maxSeq(row.id);
    fleet.completeBoot(row.machineId!);
    expect(await boot.advance(row.id, attempt, 'run-2')).toEqual({ next: 'done' });
    expect(await maxSeq(row.id)).toBe(seq);
    expect((await agentRow(row.id)).state).toBe('starting');
  });

  it('two drivers sent at once: exactly one holds the lease, every step recorded once', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    fleet.completeBoot(row.machineId!);
    const verdicts = await Promise.all([
      boot.advance(row.id, attempt, 'run-1'),
      boot.advance(row.id, attempt, 'run-2'),
    ]);
    expect(verdicts).toEqual([{ next: 'done' }, { next: 'done' }]);
    expect(cloneExecs().map((e) => e.command.at(-1))).toEqual(['acme/web', 'acme/api']);
    const a = await stepsOf(row.id, attempt);
    expect(a.steps.every((s) => s.state === 'done' || s.state === 'skipped')).toBe(true);
    // Six planned rows, then one write each for provision, then in-progress + done
    // for machine_start and both clones, then terminal skipped and ready done.
    expect(await maxSeq(row.id)).toBe(6 + 1 + 2 + 2 + 2 + 1 + 1);
    expect((await agentRow(row.id)).state).toBe('running');
  });

  it('an attempt older than the agent’s current one is never advanced', async () => {
    const row = await startingAgent();
    const first = await open(row);
    const second = await open(row);
    expect(second).toBe(first + 1);
    expect((await stepsOf(row.id, first)).outcome).toBe('failed');
    const seq = await maxSeq(row.id);
    expect(await boot.advance(row.id, first, 'run-1')).toEqual({ next: 'done' });
    expect(await maxSeq(row.id)).toBe(seq);
  });

  it('a pass that dies mid-clone is resumed at that repository by the next holder after expiry', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    fleet.completeBoot(row.machineId!);
    const real = agentInstanceBootSteps.cloneRepository;
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const clone = vi
      .spyOn(agentInstanceBootSteps, 'cloneRepository')
      .mockImplementation(async (handle, repository, token) => {
        calls += 1;
        // The first holder's second clone never returns while it holds the lease.
        if (calls === 2) await blocked;
        return real(handle, repository, token);
      });

    const dying = boot.advance(row.id, attempt, 'run-1');
    await vi.waitFor(async () => {
      const api = (await stepsOf(row.id, attempt)).steps[3]!;
      expect(api).toMatchObject({ repository: 'acme/api', state: 'in_progress' });
    });
    // While its lease is live nobody else may take the boot.
    expect(await boot.advance(row.id, attempt, 'run-2')).toEqual({ next: 'done' });

    clock.advance(AGENT_BOOT_LEASE_MS + 1_000);
    expect(await boot.advance(row.id, attempt, 'run-2')).toEqual({ next: 'done' });
    const a = await stepsOf(row.id, attempt);
    expect(shape(a.steps).slice(2, 4)).toEqual([
      ['clone', 'acme/web', 'done'],
      ['clone', 'acme/api', 'done'],
    ]);
    // The resumed holder cloned ONLY the repository in progress.
    expect(clone.mock.calls.map((c) => c[1])).toEqual(['acme/web', 'acme/api', 'acme/api']);
    expect((await agentRow(row.id)).state).toBe('running');

    // The first holder wakes up having lost its lease: it writes nothing more.
    const seq = await maxSeq(row.id);
    release();
    expect(await dying).toEqual({ next: 'done' });
    expect(await maxSeq(row.id)).toBe(seq);
  });
});

describe('deletion', () => {
  it('a delete during machine_start ends the attempt deleted, and the next pass writes nothing', async () => {
    const row = await startingAgent();
    const attempt = await open(row);
    await boot.advance(row.id, attempt, 'run-1');
    await lifecycle.delete(fx.projectIdentifier, row.id, fx.ctx);
    const a = await stepsOf(row.id, attempt);
    expect(a).toMatchObject({ outcome: 'deleted', leaseHolder: null });
    expect(a.steps[1]).toMatchObject({ step: 'machine_start', state: 'failed', detail: 'deleted' });
    const seq = await maxSeq(row.id);
    expect(await boot.advance(row.id, attempt, 'run-1')).toEqual({ next: 'done' });
    expect(await maxSeq(row.id)).toBe(seq);
  });
});
