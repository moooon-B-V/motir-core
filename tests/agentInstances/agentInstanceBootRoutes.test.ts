import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { agentInstanceBootRepository } from '@/lib/repositories/agentInstanceBootRepository';
import { agentInstanceBootService as boot } from '@/lib/services/agentInstanceBootService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { fx, otherMember, seedRepo, setUpHarness, tearDownHarness } from './_harness';

// THE BOOT READ AND ITS STREAM (Story MOTIR-7393 · MOTIR-7399, `agent-instances.md`
// AMENDMENT 6 §6–§7), as HTTP over the real services and a real Postgres. The
// steps are written by the repository during the test; the stream's sleep and
// clock are a seam the test steps by hand, so a poll happens exactly when the
// test says and a heartbeat is a clock reading, not a 15-second wait.

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

const read = await import('@/app/api/projects/[key]/instances/[id]/boot/route');
const live = await import('@/app/api/projects/[key]/instances/[id]/boot/stream/route');

async function actAs(userId: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
}

// The stream's seam: each poll waits for the test's `tick()`, and the clock is virtual.
let now = 0;
let waiting: Array<() => void> = [];
const tick = async () => {
  const next = waiting.shift();
  expect(next, 'the stream should be waiting to poll').toBeDefined();
  next!();
  // Let the poll run and write its frames.
  await new Promise((resolve) => setTimeout(resolve, 50));
};

beforeEach(async () => {
  await setUpHarness();
  await seedRepo('acme', 'web');
  await actAs(fx.ownerId);
  now = 1_000_000;
  waiting = [];
  vi.spyOn(live.agentBootStreamClock, 'now').mockImplementation(() => now);
  vi.spyOn(live.agentBootStreamClock, 'sleep').mockImplementation(
    () => new Promise<void>((resolve) => waiting.push(resolve)),
  );
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const params = (id: string, key = fx.projectIdentifier) => ({
  params: Promise.resolve({ key, id }),
});
const url = (id: string, suffix = '') =>
  `http://test/api/projects/${fx.projectIdentifier}/instances/${id}/boot${suffix}`;

async function agentWithAttempt(): Promise<{ row: AgentInstance; attempt: number }> {
  const dto = await lifecycle.create(
    fx.projectIdentifier,
    { name: 'yue-claude', profileId: 'claude' },
    fx.ctx,
  );
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: dto.id } });
  const { attempt } = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    boot.start(row, 'create', tx),
  );
  return { row, attempt };
}

/** Write one step's state as the driver would: a new per-agent seq. */
async function writeStep(row: AgentInstance, ordinal: number, state: 'in_progress' | 'done') {
  return withWorkspaceServiceContext(row.workspaceId, async (tx) => {
    const attempt = (await agentInstanceBootRepository.findCurrentAttempt(row.id, tx))!;
    const step = (await agentInstanceBootRepository.listSteps(attempt.id, tx))[ordinal]!;
    const seq = (await agentInstanceBootRepository.maxSeq(row.id, tx)) + 1;
    return agentInstanceBootRepository.updateStep(step.id, { seq, state }, tx);
  });
}

async function closeAttempt(row: AgentInstance, outcome: 'running' | 'failed') {
  await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
    const attempt = (await agentInstanceBootRepository.findCurrentAttempt(row.id, tx))!;
    await agentInstanceBootRepository.closeAttempt(
      attempt.id,
      { endedAt: new Date(), outcome },
      tx,
    );
  });
}

interface Frame {
  event: string | null;
  data: unknown;
  comment: boolean;
}

function frames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  return async (): Promise<Frame | null> => {
    const { value, done } = await reader.read();
    if (done) return null;
    const text = decoder.decode(value);
    if (text.startsWith(':')) return { event: null, data: text.trim(), comment: true };
    const event = /^event: (.*)$/m.exec(text)?.[1] ?? null;
    const data = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null') as unknown;
    return { event, data, comment: false };
  };
}

describe('GET …/boot', () => {
  it('answers the current attempt, steps in ordinal order, for the owner', async () => {
    const { row, attempt } = await agentWithAttempt();
    await writeStep(row, 1, 'in_progress');
    const res = await read.GET(new Request(url(row.id)), params(row.id));
    expect(res.status).toBe(200);
    const { boot: dto } = (await res.json()) as {
      boot: { attempt: number; kind: string; seq: number; steps: Array<Record<string, unknown>> };
    };
    expect(dto).toMatchObject({ attempt, kind: 'create', outcome: null, seq: 6 });
    expect(dto.steps.map((s) => [s.step, s.repository, s.state])).toEqual([
      ['provision', null, 'in_progress'],
      ['machine_start', null, 'in_progress'],
      ['clone', 'acme/web', 'waiting'],
      ['terminal_check', null, 'waiting'],
      ['ready', null, 'waiting'],
    ]);
    expect(JSON.stringify(dto)).not.toMatch(/lease|workspaceId/);
  });

  it('answers { boot: null } for an agent that never booted under the driver', async () => {
    const dto = await lifecycle.create(
      fx.projectIdentifier,
      { name: 'yue-claude', profileId: 'claude' },
      fx.ctx,
    );
    const res = await read.GET(new Request(url(dto.id)), params(dto.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ boot: null });
  });

  it('answers 404 for another member’s agent, a missing agent and another project’s key', async () => {
    const { row } = await agentWithAttempt();
    const other = await otherMember();
    await actAs(other.userId);
    expect((await read.GET(new Request(url(row.id)), params(row.id))).status).toBe(404);
    await actAs(fx.ownerId);
    expect((await read.GET(new Request(url('missing')), params('missing'))).status).toBe(404);
    expect((await read.GET(new Request(url(row.id)), params(row.id, 'NOPE'))).status).toBe(404);
  });
});

describe('GET …/boot/stream', () => {
  it('refuses with JSON before any stream byte for an agent that is not the caller’s', async () => {
    const { row } = await agentWithAttempt();
    const other = await otherMember();
    await actAs(other.userId);
    const res = await live.GET(new Request(url(row.id, '/stream')), params(row.id));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('sends a snapshot, a step frame per step written, and done with the outcome', async () => {
    const { row, attempt } = await agentWithAttempt();
    const res = await live.GET(new Request(url(row.id, '/stream')), params(row.id));
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const next = frames(res.body!.getReader());

    const snapshot = await next();
    expect(snapshot).toMatchObject({ event: 'snapshot', data: { attempt, seq: 5 } });

    await writeStep(row, 1, 'in_progress');
    await tick();
    expect(await next()).toMatchObject({
      event: 'step',
      data: { step: 'machine_start', state: 'in_progress', seq: 6, attempt },
    });
    // A row carries its LATEST state: two writes between polls are one frame.
    await writeStep(row, 1, 'done');
    await writeStep(row, 2, 'in_progress');
    await tick();
    expect(await next()).toMatchObject({ event: 'step', data: { state: 'done', seq: 7 } });
    expect(await next()).toMatchObject({
      event: 'step',
      data: { step: 'clone', repository: 'acme/web', seq: 8 },
    });

    await closeAttempt(row, 'running');
    await tick();
    expect(await next()).toMatchObject({ event: 'done', data: { state: 'running' } });
    expect(await next()).toBeNull();
  });

  it('resumes from ?since with exactly the steps after the cursor', async () => {
    const { row } = await agentWithAttempt();
    await writeStep(row, 0, 'done'); // seq 6
    await writeStep(row, 1, 'in_progress'); // seq 7
    const res = await live.GET(new Request(url(row.id, '/stream?since=6')), params(row.id));
    const next = frames(res.body!.getReader());
    expect(await next()).toMatchObject({ event: 'snapshot' });
    const resumed = await next();
    expect(resumed).toMatchObject({ event: 'step', data: { step: 'machine_start', seq: 7 } });
    await writeStep(row, 1, 'done'); // seq 8
    await tick();
    expect(await next()).toMatchObject({ event: 'step', data: { seq: 8 } });
  });

  it('sends a fresh snapshot when a new attempt begins', async () => {
    const { row } = await agentWithAttempt();
    const res = await live.GET(new Request(url(row.id, '/stream')), params(row.id));
    const next = frames(res.body!.getReader());
    expect(await next()).toMatchObject({ event: 'snapshot', data: { attempt: 1 } });
    await withWorkspaceServiceContext(row.workspaceId, (tx) => boot.start(row, 'wake', tx));
    await tick();
    expect(await next()).toMatchObject({
      event: 'snapshot',
      data: { attempt: 2, kind: 'wake' },
    });
  });

  it('a stream on an attempt already closed replays it and closes at once', async () => {
    const { row } = await agentWithAttempt();
    await closeAttempt(row, 'failed');
    const res = await live.GET(new Request(url(row.id, '/stream')), params(row.id));
    const next = frames(res.body!.getReader());
    expect(await next()).toMatchObject({ event: 'snapshot' });
    expect(await next()).toMatchObject({ event: 'done', data: { state: 'failed' } });
    expect(await next()).toBeNull();
  });

  it('writes a heartbeat after 15 seconds with no step', async () => {
    const { row } = await agentWithAttempt();
    const res = await live.GET(new Request(url(row.id, '/stream')), params(row.id));
    const next = frames(res.body!.getReader());
    await next();
    now += live.AGENT_BOOT_STREAM_HEARTBEAT_MS;
    await tick();
    expect(await next()).toEqual({ event: null, data: ': heartbeat', comment: true });
  });

  it('stops polling once the connection is closed', async () => {
    const { row } = await agentWithAttempt();
    const polls = vi.spyOn(boot, 'readBootSince');
    const res = await live.GET(new Request(url(row.id, '/stream')), params(row.id));
    const reader = res.body!.getReader();
    await frames(reader)();
    expect(polls).toHaveBeenCalledTimes(1);
    await reader.cancel();
    await tick();
    expect(polls).toHaveBeenCalledTimes(1);
    expect(waiting).toEqual([]);
  });
});
