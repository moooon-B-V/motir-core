import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  AgentInstanceImageTooOldError,
  AgentInstanceNotFoundError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentInstanceWrongProjectError,
  AgentNotSignedInError,
  AgentProfileCannotRunError,
  AgentRunCardNotReadyError,
} from '@/lib/agentInstances/errors';
import { DispatchRunAgentBusyError } from '@/lib/dispatchRuns/errors';
import { HostedRunRepositoryNotWritableError } from '@/lib/hostedRuns/errors';
import { engineJob } from '@/lib/jobs/engine/registry';
import { JobRunDefer } from '@/lib/jobs/engine/defer';
import { jobServices } from '@/lib/jobs/services';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { agentInstanceBootService } from '@/lib/services/agentInstanceBootService';
import {
  agentInstanceHandle,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import {
  AGENT_RUN_BOOT_WAIT_MS,
  AGENT_RUN_LAUNCH_POLL_MS,
  agentInstanceRunService as runs,
  agentRunLaunchKey,
} from '@/lib/services/agentInstanceRunService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { hostedRunKeyService } from '@/lib/services/hostedRunKeyService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestLink } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import {
  clock,
  debits,
  fleet,
  fx,
  MIN,
  otherMember,
  seedRepo,
  setUpHarness,
  stub,
  tearDownHarness,
} from './_harness';

// START A CARD'S RUN IN MY AGENT (Story MOTIR-6864 · MOTIR-7026,
// `docs/decisions/agent-instance-run.md` §1, §2, §4, §5) — against a real
// Postgres, the fake persistent fleet (its `exec` answering as the agent's
// terminal server would) and motir-ai / GitHub stubbed at `fetch`.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no run, no claim, no
// token, and — for every refusal before the wake — no machine started.

const MASTER = 'm'.repeat(48);

/** What the fake agent's terminal server answers. */
const agentSide = {
  launcher: 0,
  signIn: 'signed_in' as string,
  launch: { exitCode: 0, stdout: '{"session":"sess-1"}\n', stderr: '' } as PersistentExecResult,
  launchThrows: false,
};

function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line === 'motir agent-terminal run --help') {
    return { exitCode: agentSide.launcher, stdout: '', stderr: '' };
  }
  if (line.endsWith('motir agent-terminal signin')) {
    return ok(`${JSON.stringify({ profile: 'claude', state: agentSide.signIn })}\n`);
  }
  if (line.includes('motir agent-terminal run ')) {
    if (agentSide.launchThrows) throw new Error('the exec could not reach the machine');
    return agentSide.launch;
  }
  return ok();
}

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  agentSide.launcher = 0;
  agentSide.signIn = 'signed_in';
  agentSide.launch = { exitCode: 0, stdout: '{"session":"sess-1"}\n', stderr: '' };
  agentSide.launchThrows = false;
  fleet.setExecResponder(answer);
  await seedRepo('acme', 'web');
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx.projectIdentifier;
const agentRow = async (id: string) => (await adminDb.agentInstance.findUnique({ where: { id } }))!;
const runRows = () => adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId } });
const tokens = () => adminDb.apiToken.findMany({ where: { dispatchRunId: { not: null } } });
const launchJobs = () =>
  adminDb.jobQueueRun.findMany({ where: { jobId: 'agent-instance-run/launch' } });
const launches = () => fleet.execs.filter((e) => e.command.includes('--run-id'));
const starts = () => fleet.operations.filter((op) => op.startsWith('machine:start'));

async function agent(name = 'yue-claude'): Promise<string> {
  const dto = await lifecycle.create(KEY(), { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  return dto.id;
}

async function card(title = 'a card', parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

function start(workItemKey: string, agentInstanceId: string, idempotencyKey?: string) {
  return runs.start({ workItemKey, agentInstanceId, idempotencyKey }, fx.ctx);
}

/** Drive the launch job's handler for a run, as the engine would. */
async function runLaunchJob(dispatchRunId: string): Promise<unknown> {
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  return engineJob('agent-instance-run/launch')!.handler(
    {
      step,
      event: {
        data: {
          workspaceId: fx.workspaceId,
          dispatchRunId,
          idempotencyKey: agentRunLaunchKey(dispatchRunId),
        },
      },
    } as never,
    jobServices as never,
  );
}

async function expectNothingStarted(cardId: string, startsBefore: number): Promise<void> {
  expect(await runRows()).toEqual([]);
  expect(await tokens()).toEqual([]);
  expect(await launchJobs()).toEqual([]);
  expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: cardId } })).status).toBe('todo');
  expect(starts()).toHaveLength(startsBefore);
}

describe('the boot probes (§4)', () => {
  it('a boot records the launcher once per digest and the sign-in every boot; a hibernate records it too', async () => {
    const id = await agent();
    const row = await agentRow(id);
    expect(row).toMatchObject({
      runLauncher: 'present',
      runLauncherDigest: row.imageDigest,
      signInState: 'signed_in',
    });
    expect(row.signInCheckedAt).not.toBeNull();

    agentSide.signIn = 'signed_out';
    await lifecycle.hibernate(KEY(), id, fx.ctx);
    expect((await agentRow(id)).signInState).toBe('signed_out');

    const probes = () =>
      fleet.execs.filter((e) => e.command.join(' ') === 'motir agent-terminal run --help');
    expect(probes()).toHaveLength(1);
    agentSide.signIn = 'signed_in';
    await lifecycle.wake(KEY(), id, fx.ctx);
    // Once per digest: the wake re-asks the sign-in, never the launcher.
    expect(probes()).toHaveLength(1);
    expect((await agentRow(id)).signInState).toBe('signed_in');
  });

  it('an image without the launcher records `absent`; an unanswered probe records nothing', async () => {
    agentSide.launcher = 1;
    const absent = await agent('old-image');
    expect((await agentRow(absent)).runLauncher).toBe('absent');

    agentSide.launcher = -1;
    agentSide.signIn = 'not-a-state';
    const unanswered = await agent('no-answer');
    expect(await agentRow(unanswered)).toMatchObject({
      runLauncher: 'unknown',
      runLauncherDigest: null,
      signInState: 'unknown',
      signInCheckedAt: null,
    });
  });

  it('nothing is probed while the terminal is off, and a failing exec leaves the record alone', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    const off = await agent('terminal-off');
    expect((await agentRow(off)).runLauncher).toBe('unknown');
    expect(await lifecycle.probeSignIn('no-such-agent')).toBeNull();

    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
    fleet.setExecResponder((command) => {
      if (command[0] === 'motir' || command.includes('signin')) throw new Error('exec refused');
      return answer(command);
    });
    const failing = await agent('exec-fails');
    expect(await agentRow(failing)).toMatchObject({
      runLauncher: 'unknown',
      signInState: 'unknown',
    });
  });
});

describe('start — a ready leaf in a running, signed-in agent', () => {
  it('opens the run `origin: instance`, claims and stamps the card, enqueues the launch — and the launch hands the token on stdin', async () => {
    const id = await agent();
    const item = await card();
    const mintKey = vi.spyOn(hostedRunKeyService, 'mintRunKey');

    const started = await start(item.identifier, id);
    expect(started).toMatchObject({ created: true, woke: false });

    const run = (await runRows())[0]!;
    expect(run).toMatchObject({
      id: started.dispatchRunId,
      command: 'run',
      origin: 'instance',
      agentInstanceId: id,
      agent: 'claude',
      model: null,
      status: 'running',
    });
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    expect(legs.map((l) => [l.workItemKey, l.disposition])).toEqual([[item.identifier, 'queued']]);
    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      status: 'in_progress',
      assigneeId: fx.ownerId,
      implementationSource: 'byok',
      implementationHarness: 'claude',
      implementationModel: null,
    });
    const jobs = await launchJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(agentRunLaunchKey(run.id));
    // The token is minted by the launch, never before it.
    expect(await tokens()).toEqual([]);

    expect(await runLaunchJob(run.id)).toBe('launched');
    const minted = await tokens();
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ dispatchRunId: run.id, userId: fx.ownerId });

    const [exec] = launches();
    expect(exec!.command).toEqual([
      'runuser',
      '-u',
      'node',
      '--',
      'env',
      'HOME=/home/node',
      'motir',
      'agent-terminal',
      'run',
      item.identifier,
      '--run-id',
      run.id,
    ]);
    const creds = JSON.parse(exec!.stdin!) as { apiUrl: string; token: string };
    expect(creds.token).toMatch(/\S{20,}/);
    expect(exec!.command.join(' ')).not.toContain(creds.token);
    expect(minted[0]!.tokenPrefix).toBe(creds.token.slice(0, minted[0]!.tokenPrefix.length));

    // No gateway key, no usage row: the charge is the agent's machine time (§5).
    expect(mintKey).not.toHaveBeenCalled();
    // An `AgentRunUsage` row is written by motir-ai's machine debit against a
    // `coreRunId`; no debit names this run.
    expect(debits().some((c) => JSON.stringify(c.body).includes(run.id))).toBe(false);
    const log = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: run.id, kind: 'log' },
    });
    expect(log.map((e) => e.body)).toEqual([
      expect.stringContaining('run started in agent yue-claude'),
    ]);
    expect((await dispatchRunService.getRun(run.id, fx.ctx)).agentInstance?.name).toBe(
      'yue-claude',
    );

    // A replay of the job finds the run launched and does nothing new.
    expect(await runLaunchJob(run.id)).toBe('launched');
  });

  it('the same key again answers the run it started, and a start without a key opens its own', async () => {
    const id = await agent();
    const item = await card();
    const first = await start(item.identifier, id, 'press-1');
    const again = await start(item.identifier, id, 'press-1');
    expect(again).toEqual({ dispatchRunId: first.dispatchRunId, created: false, woke: false });
    expect(await runRows()).toHaveLength(1);
  });

  it('a hibernated agent is woken first, and the same start then launches', async () => {
    const id = await agent();
    await lifecycle.hibernate(KEY(), id, fx.ctx);
    const before = starts().length;
    const item = await card();

    const started = await start(item.identifier, id);
    expect(started.woke).toBe(true);
    expect(starts()).toHaveLength(before + 1);
    expect((await agentRow(id)).state).toBe('running');
    expect(await runLaunchJob(started.dispatchRunId)).toBe('launched');
  });

  it('a parent opens a `run_scope` run, its legs in claim order', async () => {
    const id = await agent();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'a story' },
      fx.ctx,
    );
    const later = await card('later', story.id);
    const earlier = await card('earlier', story.id);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: later.id,
      toId: earlier.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const started = await start(story.identifier, id);
    const run = (await runRows())[0]!;
    expect(run).toMatchObject({ id: started.dispatchRunId, command: 'run_scope' });
    const legs = await adminDb.dispatchRunCard.findMany({
      where: { dispatchRunId: run.id },
      orderBy: { position: 'asc' },
    });
    expect(legs.map((l) => l.workItemKey)).toEqual([earlier.identifier, later.identifier]);

    expect(await runLaunchJob(run.id)).toBe('launched');
    // The launcher is asked for the scope target, the card the run was started on.
    expect(launches()[0]!.command).toContain(story.identifier);
  });
});

describe('start — every refusal starts nothing', () => {
  it('not the owner, a deleted agent and an unknown id are one answer', async () => {
    const id = await agent();
    const item = await card();
    const before = starts().length;
    const other = await otherMember();
    const theirs = await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId!,
        projectId: fx.projectId,
        ownerId: other.userId,
        name: 'theirs',
        profileId: 'claude',
        imageTag: 't',
        imageDigest: 'sha256:x',
        region: 'iad',
        state: 'running',
      },
    });
    await expect(start(item.identifier, theirs.id)).rejects.toBeInstanceOf(
      AgentInstanceNotFoundError,
    );
    await expect(start(item.identifier, 'nope')).rejects.toBeInstanceOf(AgentInstanceNotFoundError);
    await adminDb.agentInstance.update({ where: { id }, data: { deletedAt: new Date() } });
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentInstanceNotFoundError);
    await expectNothingStarted(item.id, before);
  });

  it('an agent on another project', async () => {
    const id = await agent();
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    await adminDb.agentInstance.update({ where: { id }, data: { projectId: second.id } });
    const item = await card();
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentInstanceWrongProjectError);
    await expectNothingStarted(item.id, starts().length);
  });

  it('a card that is not ready — its status, or an open blocker', async () => {
    const id = await agent();
    const before = starts().length;
    const blocker = await card('blocker');
    const item = await card('blocked');
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: item.id,
      toId: blocker.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });
    const err = await start(item.identifier, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunCardNotReadyError);
    expect((err as AgentRunCardNotReadyError).detail).toBe('it is waiting on an open blocker');
    await expectNothingStarted(item.id, before);

    await adminDb.workItem.update({ where: { id: blocker.id }, data: { status: 'in_review' } });
    const status = await start(blocker.identifier, id).catch((e: unknown) => e);
    expect((status as AgentRunCardNotReadyError).detail).toMatch(/in_review/);

    // A parent whose scope is not claimable names the scope's own reason.
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'a story' },
      fx.ctx,
    );
    const child = await card('child', story.id);
    await adminDb.workItem.update({ where: { id: child.id }, data: { status: 'in_review' } });
    await expect(start(story.identifier, id)).rejects.toBeInstanceOf(AgentRunCardNotReadyError);
    expect(await runRows()).toEqual([]);
  });

  it('a run already running in the agent — named with its card', async () => {
    const id = await agent();
    const busy = await card('busy');
    const first = await start(busy.identifier, id);
    const item = await card();
    const err = await start(item.identifier, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchRunAgentBusyError);
    expect(err).toMatchObject({ runId: first.dispatchRunId, workItemKey: busy.identifier });
    expect(await runRows()).toHaveLength(1);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'todo',
    );
  });

  it('an image without the launcher, a coding agent that cannot run, a recorded sign-out, a busy state', async () => {
    const id = await agent();
    const item = await card();
    const before = starts().length;

    await adminDb.agentInstance.update({
      where: { id },
      data: { runLauncherDigest: 'sha256:old' },
    });
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentInstanceImageTooOldError);
    await adminDb.agentInstance.update({
      where: { id },
      data: { runLauncher: 'absent', runLauncherDigest: (await agentRow(id)).imageDigest },
    });
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentInstanceImageTooOldError);
    await adminDb.agentInstance.update({ where: { id }, data: { runLauncher: 'present' } });

    await adminDb.agentInstance.update({ where: { id }, data: { profileId: 'cursor' } });
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentProfileCannotRunError);
    await adminDb.agentInstance.update({ where: { id }, data: { profileId: 'claude' } });

    await adminDb.agentInstance.update({ where: { id }, data: { state: 'hibernating' } });
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(
      AgentInstanceStateConflictError,
    );
    // A sleeping agent recorded signed out is refused WITHOUT waking it.
    await adminDb.agentInstance.update({
      where: { id },
      data: { state: 'hibernated', signInState: 'signed_out' },
    });
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentNotSignedInError);
    await expectNothingStarted(item.id, before);
  });

  it('a running agent found signed out by the live probe', async () => {
    const id = await agent();
    const item = await card();
    agentSide.signIn = 'signed_out';
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentNotSignedInError);
    expect((await agentRow(id)).signInState).toBe('signed_out');
    await expectNothingStarted(item.id, starts().length);
  });

  it('a repository the App cannot write', async () => {
    const id = await agent();
    const item = await card();
    stub.installation = { 'acme/web': 404 };
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(
      HostedRunRepositoryNotWritableError,
    );
    await expectNothingStarted(item.id, starts().length);
  });

  it('a deployment that cannot reach an agent', async () => {
    const id = await agent();
    const item = await card();
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentInstancesUnavailableError);
    await expectNothingStarted(item.id, starts().length);
  });

  it('the wake’s own refusal is passed through unchanged, with nothing opened', async () => {
    const id = await agent();
    await lifecycle.hibernate(KEY(), id, fx.ctx);
    const item = await card();
    const before = starts().length;
    stub.mayRun = false;
    const err = await start(item.identifier, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentInstanceStartRefusedError);
    expect((err as AgentInstanceStartRefusedError).reason).toBe('credits');
    await expectNothingStarted(item.id, before);
    expect((await agentRow(id)).state).toBe('hibernated');
  });

  it('a wake whose machine fails is refused, and nothing is opened', async () => {
    const id = await agent();
    await lifecycle.hibernate(KEY(), id, fx.ctx);
    const item = await card();
    fleet.failNextStart('no capacity');
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(
      AgentInstanceStateConflictError,
    );
    expect(await runRows()).toEqual([]);
  });

  it('a caller without `instance:use` is refused before anything is read', async () => {
    const id = await agent();
    const item = await card();
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValueOnce(
      new PermissionDeniedError(fx.projectId, 'instance:use'),
    );
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await runRows()).toEqual([]);
  });
});

describe('the race — two starts on one agent', () => {
  it('one opens, the other is refused naming the winner and its card', async () => {
    const id = await agent();
    const a = await card('a');
    const b = await card('b');
    const results = await Promise.allSettled([start(a.identifier, id), start(b.identifier, id)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<{ dispatchRunId: string }>).value;
    const err = (lost[0] as PromiseRejectedResult).reason as DispatchRunAgentBusyError;
    expect(err).toBeInstanceOf(DispatchRunAgentBusyError);
    const winnerRun = (await runRows())[0]!;
    const winnerKey = (
      await adminDb.dispatchRunCard.findFirstOrThrow({ where: { dispatchRunId: winnerRun.id } })
    ).workItemKey;
    expect(err).toMatchObject({ runId: winner.dispatchRunId, workItemKey: winnerKey });
    expect(await runRows()).toHaveLength(1);
  });
});

describe('the open itself refusing', () => {
  it('an open that throws opens nothing and is passed through; a busy refusal that already names its run is kept', async () => {
    const id = await agent();
    const item = await card();
    const open = vi.spyOn(dispatchRunService, 'open');
    open.mockRejectedValueOnce(new Error('the open broke'));
    await expect(start(item.identifier, id)).rejects.toThrow('the open broke');
    const unnamed = new DispatchRunAgentBusyError(id, null);
    open.mockRejectedValueOnce(unnamed);
    await expect(start(item.identifier, id)).rejects.toBe(unnamed);
    expect(await runRows()).toEqual([]);
    expect(await launchJobs()).toEqual([]);
  });

  it('a key with no project prefix names no card', async () => {
    const id = await agent();
    await expect(start('NODASH', id)).rejects.toThrow();
    expect(await runRows()).toEqual([]);
  });
});

describe('after the open — every failure ends the run and leaves nothing live', () => {
  it('a claim refused after the open ends the run failed', async () => {
    const id = await agent();
    const item = await card();
    vi.spyOn(workItemsService, 'claimWorkItem').mockResolvedValueOnce({
      outcome: 'taken',
    } as never);
    await expect(start(item.identifier, id)).rejects.toBeInstanceOf(AgentRunCardNotReadyError);
    const run = (await runRows())[0]!;
    expect(run.status).toBe('failed');
    expect(await launchJobs()).toEqual([]);
    // The end path is idempotent: a second end closes nothing.
    expect(await runs.end(run.id, 'failed', 'again')).toEqual({
      closed: false,
      runCredential: 0,
      sessionStop: 'not_asked',
    });
  });

  it('the launcher refusing ends the run failed and revokes the token; the card keeps its status', async () => {
    const id = await agent();
    const item = await card();
    const { dispatchRunId } = await start(item.identifier, id);
    agentSide.launch = { exitCode: 1, stdout: '{"error":"run_active"}\n', stderr: '' };
    expect(await runLaunchJob(dispatchRunId)).toBe('failed');
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } });
    expect(run.status).toBe('failed');
    expect(await tokens()).toEqual([]);
    const lines = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId, kind: 'log' },
    });
    expect(lines.at(-1)!.body).toContain('refused it (run_active)');
    // §6: a run that did not succeed leaves its card where the work left it.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_progress',
    );
    expect(await runLaunchJob(dispatchRunId)).toBe('noop');
  });

  it('an exec that cannot reach the machine ends the run failed', async () => {
    const id = await agent();
    const item = await card();
    const { dispatchRunId } = await start(item.identifier, id);
    agentSide.launchThrows = true;
    expect(await runs.launchNow(dispatchRunId)).toBe('failed');
    expect(await tokens()).toEqual([]);
  });

  it('the launch finds the agent signed out, or its image without the launcher', async () => {
    const id = await agent();
    const item = await card();
    const first = await start(item.identifier, id);
    agentSide.signIn = 'signed_out';
    expect(await runs.launchNow(first.dispatchRunId)).toBe('failed');
    const lines = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: first.dispatchRunId, kind: 'log' },
    });
    expect(lines.at(-1)!.body).toContain('isn’t signed in');

    agentSide.signIn = 'signed_in';
    const next = await card('next');
    const second = await start(next.identifier, id);
    await adminDb.agentInstance.update({ where: { id }, data: { runLauncher: 'absent' } });
    expect(await runs.launchNow(second.dispatchRunId)).toBe('failed');
  });

  it('the agent stopped before the launch', async () => {
    const id = await agent();
    const item = await card();
    const { dispatchRunId } = await start(item.identifier, id);
    await adminDb.agentInstance.update({ where: { id }, data: { state: 'hibernated' } });
    expect(await runs.launchNow(dispatchRunId)).toBe('failed');
    expect(await runLaunchJob(dispatchRunId)).toBe('noop');
  });

  it('the job waits for an agent still coming up, then fails the run at the boot window', async () => {
    const id = await agent();
    const item = await card();
    const { dispatchRunId } = await start(item.identifier, id);
    // The machine is stopped and the record says it is waking: the settle finds it
    // still coming up, so the pass defers.
    await fleet.stop(agentInstanceHandle(await agentRow(id))!);
    await adminDb.agentInstance.update({ where: { id }, data: { state: 'waking' } });
    // AMENDMENT 6 §4: the launcher READS a boot, never drives it beside its driver.
    const drive = vi.spyOn(agentInstanceBootService, 'advance');
    // The boot window is measured on the lifecycle's clock.
    await adminDb.dispatchRun.update({
      where: { id: dispatchRunId },
      data: { startedAt: clock.now() },
    });
    expect(await runs.awaitAgent(dispatchRunId)).toEqual({
      deferUntil: new Date(clock.now().getTime() + AGENT_RUN_LAUNCH_POLL_MS),
    });
    await expect(runLaunchJob(dispatchRunId)).rejects.toBeInstanceOf(JobRunDefer);
    clock.advance(AGENT_RUN_BOOT_WAIT_MS + MIN);
    expect(await runs.awaitAgent(dispatchRunId)).toBe('failed');
    expect(drive).not.toHaveBeenCalled();
    expect(
      (await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } })).status,
    ).toBe('failed');
  });

  it('the job ends a run whose agent is gone, and skips a run already closed', async () => {
    const id = await agent();
    const item = await card();
    const { dispatchRunId } = await start(item.identifier, id);
    await adminDb.agentInstance.update({ where: { id }, data: { state: 'failed' } });
    expect(await runLaunchJob(dispatchRunId)).toBe('failed');
    expect(await runs.awaitAgent(dispatchRunId)).toBe('noop');
    expect(await runs.launchNow('no-such-run')).toBe('noop');
  });
});

describe('the card’s agent picker', () => {
  it('lists only the caller’s agents on the card’s project, each with its running run and its refusal', async () => {
    const free = await agent('free');
    const busy = await agent('busy');
    const busyCard = await card('busy card');
    const { dispatchRunId } = await start(busyCard.identifier, busy);
    await adminDb.agentInstance.update({
      where: { id: free },
      data: { runLauncherDigest: 'sha256:another' },
    });
    const other = await otherMember();
    await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId!,
        projectId: fx.projectId,
        ownerId: other.userId,
        name: 'theirs',
        profileId: 'claude',
        imageTag: 't',
        imageDigest: 'sha256:x',
        region: 'iad',
      },
    });
    const item = await card();
    const byMany = vi.spyOn(dispatchRunRepository, 'findRunningByAgentInstances');
    const byOne = vi.spyOn(dispatchRunRepository, 'findRunningByAgentInstance');

    const { agents } = await runs.listAgentsForCard(item.identifier, fx.ctx);
    expect(agents.map((a) => a.name).sort()).toEqual(['busy', 'free']);
    expect(agents.find((a) => a.name === 'busy')).toMatchObject({
      profileName: 'Claude Code',
      state: 'running',
      runLauncher: 'present',
      signInState: 'signed_in',
      runningRun: {
        id: dispatchRunId,
        workItemKey: busyCard.identifier,
        workItemTitle: busyCard.title,
      },
      refusal: 'agent_instance_run_active',
    });
    expect(agents.find((a) => a.name === 'free')).toMatchObject({
      runLauncher: 'unknown',
      runningRun: null,
      refusal: 'agent_instance_image_too_old',
    });
    // One running-run read for every agent — never one per agent.
    expect(byMany).toHaveBeenCalledTimes(1);
    expect(byOne).not.toHaveBeenCalled();
  });

  it('a hibernated agent never probed is offered with its refusal and no sign-in time', async () => {
    const id = await agent();
    await adminDb.agentInstance.update({
      where: { id },
      data: { state: 'hibernating', signInCheckedAt: null },
    });
    const item = await card();
    const { agents } = await runs.listAgentsForCard(item.identifier, fx.ctx);
    expect(agents).toMatchObject([
      { id, signInCheckedAt: null, refusal: 'agent_instance_state_conflict' },
    ]);
  });

  it('any other failure of the permission read is not swallowed', async () => {
    const item = await card();
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValueOnce(new Error('db down'));
    await expect(runs.listAgentsForCard(item.identifier, fx.ctx)).rejects.toThrow('db down');
  });

  it('a caller without `instance:use` is offered no agents', async () => {
    await agent();
    const item = await card();
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValueOnce(
      new PermissionDeniedError(fx.projectId, 'instance:use'),
    );
    expect(await runs.listAgentsForCard(item.identifier, fx.ctx)).toEqual({ agents: [] });
  });
});
