import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/messages/en.json';
import type { AgentInstance } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { AGENT_BOOT_LEASE_MS, INSTANCE_BOOT_DEADLINE_MS } from '@/lib/agentInstances/config';
import type { AgentInstanceBootDto } from '@/lib/dto/agentInstances';
import { engineJob } from '@/lib/jobs/engine/registry';
// Registers the job the engine runs.
import '@/lib/jobs/definitions/agentInstanceBoot';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { jobServices } from '@/lib/jobs/services';
import type { AgentInstanceBootData } from '@/lib/jobs/types';
import { agentInstanceBootRepository } from '@/lib/repositories/agentInstanceBootRepository';
import {
  agentInstanceBootSteps,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceRunService as runs } from '@/lib/services/agentInstanceRunService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { AgentBootReadout } from '@/app/(authed)/my-agents/_components/AgentBootReadout';
import {
  applyBootFrame,
  type AgentBootFrame,
} from '@/app/(authed)/my-agents/_components/useAgentBoot';
import { adminDb } from '../helpers/adminDb';
import { bootDriver } from '../helpers/agentBootDriver';
import {
  clock,
  fleet,
  fx,
  intervals,
  otherMember,
  seedRepo,
  setUpHarness,
  slots,
  tearDownHarness,
} from './_harness';

// THE STORY GATE for "Watch your agent boot" (Story MOTIR-7393 · MOTIR-7401). The
// assembled boot, through its real entry points, against the real Postgres and
// the fake persistent fleet: create / wake → the attempt and its steps → the boot
// event → the `agent-instance/boot` job's passes → running or failed; the sweep,
// a duplicate delivery and the run launcher all reaching the same boot; the
// stream reporting it; and the panel's read-out over the frames it sent.
//
// No in-process worker runs here: every boot event is RECORDED (`bootDriver.sent`)
// and each pass is the job's own handler, called as the engine calls it.

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));

const live = await import('@/app/api/projects/[key]/instances/[id]/boot/stream/route');

async function actAs(userId: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
}

// The stream's seam: each poll waits for the test's `tick()`.
let waiting: Array<() => void> = [];
const tick = async () => {
  const next = waiting.shift();
  expect(next, 'the stream should be waiting to poll').toBeDefined();
  next!();
  await new Promise((resolve) => setTimeout(resolve, 50));
};

beforeEach(async () => {
  await setUpHarness();
  await seedRepo('acme', 'web');
  await seedRepo('acme', 'api');
  await actAs(fx.ownerId);
  bootDriver.inline = false;
  waiting = [];
  vi.spyOn(live.agentBootStreamClock, 'now').mockImplementation(() => clock.now().getTime());
  vi.spyOn(live.agentBootStreamClock, 'sleep').mockImplementation(
    () => new Promise<void>((resolve) => waiting.push(resolve)),
  );
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx.projectIdentifier;
const agentRow = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const attemptOf = (agentInstanceId: string, attempt: number) =>
  adminDb.agentInstanceBootAttempt.findUniqueOrThrow({
    where: { agentInstanceId_attempt: { agentInstanceId, attempt } },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  });
const shape = (rows: Array<{ step: string; repository: string | null; state: string }>) =>
  rows.map((s) => [s.step, s.repository, s.state]);
const cloneExecs = () => fleet.execs.filter((e) => e.command.includes('motir-clone'));

/** One delivery of the boot event, through the job's own handler: its verdict. */
async function deliver(data: AgentInstanceBootData, runId: string): Promise<'defer' | 'done'> {
  const step = { run: async <T,>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  try {
    await engineJob('agent-instance/boot')!.handler(
      { step, runId, attempt: 1, event: { data } } as never,
      jobServices as never,
    );
    return 'done';
  } catch (err) {
    if (isJobRunDefer(err)) return 'defer';
    throw err;
  }
}

/** Create an agent whose machine waits for the test; the event its create sent. */
async function booting(
  name = 'yue-claude',
): Promise<{ row: AgentInstance; event: AgentInstanceBootData }> {
  fleet.setBootBehaviour('never_start');
  const dto = await lifecycle.create(KEY(), { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('starting');
  const event = bootDriver.sent.find((e) => e.instanceId === dto.id)!;
  return { row: await agentRow(dto.id), event };
}

async function expectFailed(id: string, reason: RegExp): Promise<void> {
  const agent = await agentRow(id);
  expect(agent.state).toBe('failed');
  expect(agent.failureReason).toMatch(reason);
  expect((await intervals()).filter((i) => i.endedAt === null)).toEqual([]);
  expect((await intervals()).at(-1)).toMatchObject({ endReason: 'lost' });
  expect(await slots()).toEqual([]);
}

interface Frame {
  event: string | null;
  data: unknown;
}
function framesOf(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  return async (): Promise<Frame | null> => {
    const { value, done } = await reader.read();
    if (done) return null;
    const text = decoder.decode(value);
    if (text.startsWith(':')) return { event: null, data: null };
    return {
      event: /^event: (.*)$/m.exec(text)?.[1] ?? null,
      data: JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null') as unknown,
    };
  };
}
const stream = (id: string, since = 0) =>
  live.GET(
    new Request(
      `http://test/api/projects/${KEY()}/instances/${id}/boot/stream${since ? `?since=${since}` : ''}`,
    ),
    { params: Promise.resolve({ key: KEY(), id }) },
  );

describe('1 · a whole boot, through its real doors', () => {
  it('create → event → driver passes → running: every step in seq order, the interval on the machine’s start, the idle timer armed', async () => {
    const { row, event } = await booting();
    expect(await deliver(event, 'job-1')).toBe('defer');
    clock.advance(4_000);
    fleet.completeBoot(row.machineId!);
    const startedAt = clock.now();
    clock.advance(1_000);
    expect(await deliver(event, 'job-1')).toBe('done');

    const a = await attemptOf(row.id, 1);
    expect(a.outcome).toBe('running');
    const bySeq = [...a.steps].sort((x, y) => x.seq - y.seq);
    expect(bySeq.map((s) => [s.step, s.repository])).toEqual([
      ['provision', null],
      ['machine_start', null],
      ['clone', 'acme/web'],
      ['clone', 'acme/api'],
      ['terminal_check', null],
      ['ready', null],
    ]);
    expect(a.steps[1]!.endedAt).toEqual(startedAt);
    expect(cloneExecs().map((e) => e.command.at(-1))).toEqual(['acme/web', 'acme/api']);
    expect((await agentRow(row.id)).state).toBe('running');
    expect((await intervals()).find((i) => i.endedAt === null)!.startedAt).toEqual(startedAt);
    expect(
      await adminDb.jobQueueRun.count({ where: { jobId: 'agent-instance/idle-check' } }),
    ).toBeGreaterThan(0);
  });

  it('a wake → running with both clone rows skipped and no clone run', async () => {
    const { row, event } = await booting();
    fleet.completeBoot(row.machineId!);
    expect(await deliver(event, 'job-1')).toBe('done');
    await lifecycle.hibernate(KEY(), row.id, fx.ctx);
    const execs = cloneExecs().length;
    expect((await lifecycle.wake(KEY(), row.id, fx.ctx)).state).toBe('waking');
    const wake = bootDriver.sent.at(-1)!;
    expect(wake.attempt).toBe(2);
    fleet.completeBoot(row.machineId!);
    expect(await deliver(wake, 'job-2')).toBe('done');
    const a = await attemptOf(row.id, 2);
    expect(a).toMatchObject({ kind: 'wake', outcome: 'running' });
    expect(a.steps.filter((s) => s.step === 'clone').map((s) => s.state)).toEqual([
      'skipped',
      'skipped',
    ]);
    expect(cloneExecs()).toHaveLength(execs);
  });
});

describe('2 · one failure per step, each ending the agent failed', () => {
  it('provisioning refused → provision failed, and no event is sent', async () => {
    fleet.failNextProvision('no capacity in iad');
    const dto = await lifecycle.create(KEY(), { name: 'yue-claude', profileId: 'claude' }, fx.ctx);
    const a = await attemptOf(dto.id, 1);
    expect(a.steps[0]).toMatchObject({ step: 'provision', state: 'failed' });
    expect(a.steps[0]!.detail).toMatch(/no capacity in iad/);
    expect(a.outcome).toBe('failed');
    expect(bootDriver.sent).toEqual([]);
    expect((await agentRow(dto.id)).state).toBe('failed');
    expect(await slots()).toEqual([]);
  });

  it('a machine exit → machine_start failed, with its exit code', async () => {
    const { row, event } = await booting();
    await deliver(event, 'job-1');
    fleet.exitOutside(row.machineId!, 0);
    expect(await deliver(event, 'job-1')).toBe('done');
    expect((await attemptOf(row.id, 1)).steps[1]).toMatchObject({
      state: 'failed',
      detail: 'exit code 0',
    });
    await expectFailed(row.id, /exit code 0/);
  });

  it('repo-b’s clone refused → that clone row failed, with no token in the detail', async () => {
    const { row, event } = await booting();
    fleet.setExecResponder((command) =>
      command.includes('acme/api')
        ? { exitCode: 128, stdout: '', stderr: 'fatal: could not read from remote\n' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
    fleet.completeBoot(row.machineId!);
    expect(await deliver(event, 'job-1')).toBe('done');
    const a = await attemptOf(row.id, 1);
    expect(shape(a.steps).slice(2, 4)).toEqual([
      ['clone', 'acme/web', 'done'],
      ['clone', 'acme/api', 'failed'],
    ]);
    expect(a.steps[3]!.detail).not.toMatch(/ghs_/);
    await expectFailed(row.id, /cloning acme\/api failed/);
  });

  it('the deadline passing → the step in progress failed', async () => {
    const { row, event } = await booting();
    await deliver(event, 'job-1');
    clock.advance(INSTANCE_BOOT_DEADLINE_MS);
    expect(await deliver(event, 'job-1')).toBe('done');
    expect((await attemptOf(row.id, 1)).steps[1]).toMatchObject({
      state: 'failed',
      detail: 'the machine did not start in time',
    });
    await expectFailed(row.id, /did not finish starting within 10 minutes/);
  });
});

describe('3 · one boot, one winner', () => {
  it('the driver, a duplicate event, the sweep and the run launcher fired together: one lease holder, one write per step, one clone per repository', async () => {
    const { row, event } = await booting();
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        origin: 'instance',
        agentInstanceId: row.id,
        startedAt: clock.now(),
      },
    });
    fleet.completeBoot(row.machineId!);
    // Every lease GRANTED, by holder: the single flight is who was let in.
    const granted = new Set<string>();
    const take = agentInstanceBootRepository.takeLease.bind(agentInstanceBootRepository);
    vi.spyOn(agentInstanceBootRepository, 'takeLease').mockImplementation(
      async (attemptId, holder, until, now, tx) => {
        const n = await take(attemptId, holder, until, now, tx);
        if (n === 1) granted.add(holder);
        return n;
      },
    );
    const writes: string[] = [];
    const realRecord = agentInstanceBootSteps.cloneRepository;
    vi.spyOn(agentInstanceBootSteps, 'cloneRepository').mockImplementation(
      async (handle, repository, token) => {
        writes.push(repository);
        return realRecord(handle, repository, token);
      },
    );

    await Promise.all([
      deliver(event, 'job-1'),
      deliver(event, 'job-2'),
      sweeper.sweep(),
      runs.awaitAgent(run.id),
    ]);
    // The sweep may have resent the event (an unleased boot); deliver what it sent.
    for (const resent of bootDriver.sent.slice(1)) await deliver(resent, 'job-3');

    const a = await attemptOf(row.id, 1);
    expect(a.outcome).toBe('running');
    expect(granted.size).toBe(1);
    expect(writes).toEqual(['acme/web', 'acme/api']);
    expect(cloneExecs().map((e) => e.command.at(-1))).toEqual(['acme/web', 'acme/api']);
    // Every step written once per state change: six planned, then provision, then
    // in-progress + done for machine_start and both clones, then terminal + ready.
    const maxSeq = Math.max(...a.steps.map((s) => s.seq));
    expect(maxSeq).toBe(6 + 1 + 2 + 2 + 2 + 1 + 1);
  });

  it('a driver killed mid-clone: the lease expires, the sweep resends, the new holder resumes at that repository', async () => {
    const { row, event } = await booting();
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
        // The first holder stops inside its second clone, as a killed worker does.
        if (calls === 2) await blocked;
        return real(handle, repository, token);
      });
    const dead = deliver(event, 'job-dead');
    await vi.waitFor(async () => {
      expect((await attemptOf(row.id, 1)).steps[3]).toMatchObject({ state: 'in_progress' });
    });
    expect(await lifecycle.resumeBoot(row.id)).toBe('alive');
    clock.advance(AGENT_BOOT_LEASE_MS + 1_000);
    const before = bootDriver.sent.length;
    await sweeper.sweep();
    const resent = bootDriver.sent.slice(before);
    expect(resent).toHaveLength(1);
    expect(resent[0]!.idempotencyKey).not.toBe(event.idempotencyKey);
    expect(await deliver(resent[0]!, 'job-new')).toBe('done');
    expect(clone.mock.calls.map((c) => c[1])).toEqual(['acme/web', 'acme/api', 'acme/api']);
    expect((await agentRow(row.id)).state).toBe('running');

    // The dead holder, if it ever returned, has lost the lease: it writes nothing.
    const seq = Math.max(...(await attemptOf(row.id, 1)).steps.map((s) => s.seq));
    release();
    expect(await dead).toBe('done');
    expect(Math.max(...(await attemptOf(row.id, 1)).steps.map((s) => s.seq))).toBe(seq);
  });

  it('a boot that crossed the deploy (no attempt) is given one by the sweep and finishes', async () => {
    const { row } = await booting();
    await adminDb.agentInstanceBootAttempt.deleteMany({ where: { agentInstanceId: row.id } });
    const before = bootDriver.sent.length;
    await sweeper.sweep();
    const opened = bootDriver.sent.slice(before);
    expect(opened).toHaveLength(1);
    fleet.completeBoot(row.machineId!);
    expect(await deliver(opened[0]!, 'job-1')).toBe('done');
    expect((await agentRow(row.id)).state).toBe('running');
  });
});

describe('4 · the stream, and the read-out over what it sent', () => {
  it('from the start: a snapshot, step frames in seq order, done running — and the read-out renders them', async () => {
    const { row, event } = await booting();
    const next = framesOf(await stream(row.id));
    const frames: Frame[] = [];
    frames.push((await next())!);
    expect(frames[0]).toMatchObject({ event: 'snapshot', data: { attempt: 1 } });

    await deliver(event, 'job-1');
    await tick();
    frames.push((await next())!);
    fleet.completeBoot(row.machineId!);
    clock.advance(2_000);
    await deliver(event, 'job-1');
    await tick();
    for (;;) {
      const f = await next();
      if (!f) break;
      if (f.event) frames.push(f);
    }
    expect(frames.at(-1)).toMatchObject({ event: 'done', data: { state: 'running' } });
    const seqs = frames
      .filter((f) => f.event === 'step')
      .map((f) => (f.data as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // The panel's read-out over the frames this boot actually sent.
    let shown: AgentInstanceBootDto | null = null;
    for (const f of frames) shown = applyBootFrame(shown, f as AgentBootFrame);
    expect(shown!.outcome).toBe('running');
    expect(shown!.steps.every((s) => s.state === 'done' || s.state === 'skipped')).toBe(true);
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <AgentBootReadout
          boot={{ ...shown!, outcome: null }}
          agentState="starting"
          waking={false}
          onWake={() => {}}
          onDelete={() => {}}
        />
      </NextIntlClientProvider>,
    );
    const states = [...html.matchAll(/<li data-state="([a-z_]+)"/g)].map((m) => m[1]);
    expect(states).toEqual(['done', 'done', 'done', 'done', 'skipped', 'done']);
    expect(html).toMatch(/Cloning <span[^>]*>acme\/api<\/span>/);
  });

  it('reconnected with ?since=<n> mid-boot, it sends exactly the steps after n', async () => {
    const { row, event } = await booting();
    await deliver(event, 'job-1');
    const cursor = Math.max(...(await attemptOf(row.id, 1)).steps.map((s) => s.seq));
    fleet.completeBoot(row.machineId!);
    await deliver(event, 'job-1');
    const after = (await attemptOf(row.id, 1)).steps.filter((s) => s.seq > cursor);
    const next = framesOf(await stream(row.id, cursor));
    expect(await next()).toMatchObject({ event: 'snapshot' });
    const steps: number[] = [];
    for (;;) {
      const f = await next();
      if (!f || f.event === 'done') break;
      if (f.event === 'step') steps.push((f.data as { ordinal: number }).ordinal);
    }
    expect(steps.sort()).toEqual(after.map((s) => s.ordinal).sort());
  });

  it('a non-owner is refused with the instance read’s answer before any stream byte', async () => {
    const { row } = await booting();
    const other = await otherMember();
    await actAs(other.userId);
    const res = await stream(row.id);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('deleted mid-boot: the attempt ends deleted, the stream says so, and the driver writes nothing after', async () => {
    const { row, event } = await booting();
    await deliver(event, 'job-1');
    const next = framesOf(await stream(row.id));
    await next();
    await lifecycle.delete(KEY(), row.id, fx.ctx);
    await tick();
    let last: Frame | null = null;
    for (;;) {
      const f = await next();
      if (!f) break;
      if (f.event) last = f;
    }
    expect(last).toMatchObject({ event: 'done', data: { state: 'deleted' } });
    const a = await attemptOf(row.id, 1);
    expect(a.outcome).toBe('deleted');
    const seq = Math.max(...a.steps.map((s) => s.seq));
    expect(await deliver(event, 'job-1')).toBe('done');
    expect(Math.max(...(await attemptOf(row.id, 1)).steps.map((s) => s.seq))).toBe(seq);
  });
});
