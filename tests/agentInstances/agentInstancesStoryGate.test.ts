import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
} from '@/lib/agentInstances/errors';
import { agentInstanceChargeService } from '@/lib/services/agentInstanceChargeService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { adminDb } from '../helpers/adminDb';
import {
  MIN,
  clock,
  debits,
  fleet,
  fx,
  intervals,
  otherMember,
  seedRepo,
  setUpHarness,
  slots,
  stub,
  tearDownHarness,
} from './_harness';

// THE AGENT-INSTANCES STORY GATE, motir-core (Story MOTIR-6860 · MOTIR-6876).
//
// Each card tested its own piece. This file tests the ASSEMBLED story against the
// real database and the fake persistent fleet, with motir-ai stubbed at `fetch`:
//
//   1. THE SEAM — create → running → idle sweep → hibernated → wake → delete,
//      asserting the slot, the interval and the charge (⌈seconds ÷ 60⌉) at each step;
//   2. THE GUARDS — cross-owner isolation, one winner of concurrent transitions,
//      the instance path never reading the CI fleet's `FLY_FLEET_*` config, and no
//      story file reading, storing or logging a vendor credential — each with a
//      negative control, so a guard that could never fail cannot pass;
//   3. THE EDGES — the defensive paths each service owns, driven on purpose.

beforeEach(setUpHarness);
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx.projectIdentifier;
const create = (name = 'yue-claude', ctx = fx.ctx) =>
  lifecycle.create(KEY(), { name, profileId: 'claude' }, ctx);
const row = async (id: string) => (await adminDb.agentInstance.findUnique({ where: { id } }))!;

describe('1 · the lifecycle seam, end to end', () => {
  it('create → running → idle → hibernated → wake → delete: slot, interval and charge at every step', async () => {
    await seedRepo('acme', 'web');

    // CREATE → running: one slot held under the run, one interval open, the repo cloned.
    const dto = await create();
    expect(dto.state).toBe('running');
    const [first] = await intervals();
    expect(first).toMatchObject({ endedAt: null, runId: first!.id });
    expect((await slots()).map((s) => s.ownerRef)).toEqual([first!.id]);
    expect(fleet.execs).toHaveLength(1);
    expect(debits()).toEqual([]);

    // 7 minutes 20 seconds of use, then quiet: the idle timer hibernates it.
    clock.advance(7 * MIN + 20_000);
    await lifecycle.touchActivity(dto.id);
    clock.advance(31 * MIN);
    expect(await sweeper.checkIdle(dto.id)).toBe('idle');
    await lifecycle.settleStop(dto.id, 'idle');
    expect((await row(dto.id)).state).toBe('hibernated');
    expect(await slots()).toEqual([]);
    const closed = (await intervals())[0]!;
    expect(closed).toMatchObject({ endReason: 'idle', chargeOutcome: 'charged' });
    expect(closed.credits).toBe(Math.ceil(closed.billableSeconds! / 60));
    expect(debits()).toHaveLength(1);
    expect(debits()[0]!.body).toMatchObject({
      instanceIntervalId: closed.id,
      credits: closed.credits,
      billableSeconds: closed.billableSeconds,
    });

    // WAKE → a cold boot: a new run, a new slot, a new interval.
    clock.advance(60 * MIN);
    const woken = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(woken.state).toBe('running');
    const second = (await intervals())[1]!;
    expect(second).toMatchObject({ endedAt: null, runId: second.id });
    expect((await slots()).map((s) => s.ownerRef)).toEqual([second.id]);

    // DELETE: machine then volume destroyed, the final interval closed and charged.
    clock.advance(3 * MIN + 1_000);
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    expect((await row(dto.id)).deletedAt).not.toBeNull();
    const destroyOps = fleet.operations.filter((op) => op.includes('destroy'));
    expect(destroyOps[0]).toMatch(/^machine:destroy/);
    expect(destroyOps.at(-1)).toMatch(/^volume:destroy/);
    expect(fleet.liveMachineIds()).toEqual([]);
    expect(fleet.liveVolumeIds()).toEqual([]);
    expect(await slots()).toEqual([]);
    const last = (await intervals())[1]!;
    expect(last).toMatchObject({ endReason: 'deleted', chargeOutcome: 'charged' });
    expect(last.credits).toBe(Math.ceil(last.billableSeconds! / 60));
    expect(debits()).toHaveLength(2);
    // The list no longer shows it.
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx)).total).toBe(0);
  });
});

describe('2 · the guards', () => {
  it('cross-owner isolation: another member cannot list, wake, hibernate or delete — even on the same project', async () => {
    const dto = await create();
    const other = await otherMember();
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, other)).total).toBe(0);
    await expect(lifecycle.hibernate(KEY(), dto.id, other)).rejects.toThrow(
      AgentInstanceNotFoundError,
    );
    await expect(lifecycle.wake(KEY(), dto.id, other)).rejects.toThrow(AgentInstanceNotFoundError);
    await expect(lifecycle.delete(KEY(), dto.id, other)).rejects.toThrow(
      AgentInstanceNotFoundError,
    );
    expect((await row(dto.id)).state).toBe('running');
  });

  it('concurrent transitions: two hibernates of one instance, and two deletes, each yield one winner', async () => {
    const dto = await create();
    const results = await Promise.allSettled([
      lifecycle.hibernate(KEY(), dto.id, fx.ctx),
      lifecycle.hibernate(KEY(), dto.id, fx.ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AgentInstanceStateConflictError);
    expect((await intervals()).filter((i) => i.endReason === 'hibernated')).toHaveLength(1);

    const deletes = await Promise.allSettled([
      lifecycle.delete(KEY(), dto.id, fx.ctx),
      lifecycle.delete(KEY(), dto.id, fx.ctx),
    ]);
    expect(deletes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fleet.operations.filter((op) => op.startsWith('volume:destroy'))).toHaveLength(1);
  });

  it('the LOSER of a hibernate race is refused, never told it succeeded (forced interleaving)', async () => {
    // The owner's hibernate reads `running`; before its guarded transition, the
    // idle sweep hibernates the same agent. The owner's move then moves nothing and
    // must answer a conflict — this is the race the concurrent test above can only
    // hit when the timing cooperates, forced here on every run.
    const dto = await create();
    const real = lifecycle.beginHibernate.bind(lifecycle);
    const spy = vi.spyOn(lifecycle, 'beginHibernate').mockImplementationOnce(async (id, reason) => {
      await real(id, 'idle');
      return real(id, reason);
    });
    await expect(lifecycle.hibernate(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
    spy.mockRestore();
    expect((await intervals()).map((i) => i.endReason)).toEqual(['idle']);
  });

  // ── the two static guards ─────────────────────────────────────────────────
  const STORY_FILES = [
    'lib/agentInstances',
    'lib/services/agentInstanceLifecycleService.ts',
    'lib/services/agentInstanceSweepService.ts',
    'lib/services/agentInstanceChargeService.ts',
    'lib/repositories/agentInstanceRepository.ts',
    'lib/repositories/agentInstanceIntervalRepository.ts',
    'lib/jobs/definitions/agentInstanceIdleCheck.ts',
    'lib/jobs/definitions/agentInstanceSweep.ts',
    'app/api/projects/[key]/instances',
    'app/(authed)/my-agents',
    'packages/orchestrator/src/adapters/fly/persistent.ts',
    'packages/orchestrator/src/adapters/fake/persistent.ts',
  ];
  function sourcesOf(paths: readonly string[]): Array<{ file: string; code: string }> {
    const out: Array<{ file: string; code: string }> = [];
    const walk = (p: string) => {
      if (statSync(p).isDirectory()) {
        for (const entry of readdirSync(p)) walk(join(p, entry));
      } else if (/\.tsx?$/.test(p)) {
        out.push({ file: p, code: stripComments(readFileSync(p, 'utf8')) });
      }
    };
    for (const p of paths) walk(p);
    return out;
  }
  /** Code only — a comment saying "never reads FLY_FLEET_*" is not a read. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  }

  const FLEET_CONFIG = /\bFLY_FLEET_[A-Z_]+|\bflyFleetConfig\s*\(/;
  const VENDOR_CREDENTIAL =
    /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|MOONSHOT_API_KEY|KIMI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)\b|\.claude\/\.credentials|\.claude\.json|\.codex\/auth\.json|\.config\/(goose|opencode|aider)/;
  const offenders = (pattern: RegExp, files: Array<{ file: string; code: string }>) =>
    files.filter((f) => pattern.test(f.code)).map((f) => f.file);

  it('the instance path never reads the CI fleet’s FLY_FLEET_* configuration', () => {
    const files = sourcesOf(STORY_FILES);
    expect(files.length).toBeGreaterThan(20);
    expect(offenders(FLEET_CONFIG, files)).toEqual([]);
    // Negative control: the guard catches a read, in either spelling.
    expect(
      offenders(FLEET_CONFIG, [
        { file: 'a.ts', code: "const t = process.env['FLY_FLEET_API_TOKEN'];" },
        { file: 'b.ts', code: 'const cfg = flyFleetConfig();' },
        { file: 'c.ts', code: stripComments('// never reads FLY_FLEET_API_TOKEN') },
      ]),
    ).toEqual(['a.ts', 'b.ts']);
  });

  // The ONE file allowed to NAME a credential variable: the panel's sign-in hints
  // (MOTIR-6941), whose Aider entry tells the PERSON which line to write into their
  // own `~/.env`. It is display copy — no Motir process reads, sets or forwards the
  // variable — and it is pinned below so no other value in it can slip past.
  const SIGN_IN_COPY = 'lib/agentInstances/profiles.ts';

  it('no story file reads, stores or logs a vendor credential — Motir never touches the user’s sign-in', () => {
    const files = sourcesOf(STORY_FILES);
    expect(offenders(VENDOR_CREDENTIAL, files).filter((f) => f !== SIGN_IN_COPY)).toEqual([]);
    const copy = files.find((f) => f.file === SIGN_IN_COPY);
    if (copy) {
      // Only the Aider hint's inline-code value may carry a credential name, and
      // only as a placeholder the person fills in themselves.
      const hits = copy.code.match(new RegExp(VENDOR_CREDENTIAL.source, 'g')) ?? [];
      expect(hits).toEqual(['ANTHROPIC_API_KEY']);
      expect(copy.code).toContain("values: ['ANTHROPIC_API_KEY=…', '~/.env']");
    }
    expect(
      offenders(VENDOR_CREDENTIAL, [
        { file: 'a.ts', code: 'env: { ANTHROPIC_API_KEY: key }' },
        { file: 'b.ts', code: "readFile('/home/node/.claude/.credentials.json')" },
        { file: 'c.ts', code: "cat('~/.codex/auth.json')" },
        { file: 'd.ts', code: 'const label = "your Anthropic API key";' },
      ]),
    ).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('3 · the edges', () => {
  it('the lane is unavailable when no instance fleet is configured', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', '');
    await expect(create()).rejects.toThrow(AgentInstancesUnavailableError);
    // The sweep still charges what is pending, and touches no fleet.
    expect((await sweeper.sweep()).settled).toBe(0);
  });

  it('off a billing build the pre-flight asks nothing and the sweep never stops an agent for credits', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    stub.mayRun = false;
    const dto = await create();
    expect(stub.calls.filter((c) => c.url.includes('agent-run-check'))).toEqual([]);
    await lifecycle.touchActivity(dto.id);
    expect((await sweeper.sweep()).hibernated.credits).toBe(0);
  });

  it('an unanswerable credit check keeps a running agent running', async () => {
    const dto = await create();
    stub.mayRun = 'unanswerable';
    expect((await sweeper.sweep()).hibernated.credits).toBe(0);
    expect((await row(dto.id)).state).toBe('running');
  });

  it('a concurrent create of the same name loses with the name taken, and frees its slot', async () => {
    const results = await Promise.allSettled([create('twin'), create('twin')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AgentInstanceNameTakenError);
    expect(await slots()).toHaveLength(1);
  });

  it('a clone that exits non-zero with no output fails with the exit code', async () => {
    await seedRepo('acme', 'web');
    fleet.setNextExecResult({ exitCode: 128, stdout: '', stderr: '' });
    const dto = await create();
    expect(dto.state).toBe('failed');
    expect(dto.failureReason).toContain('exit 128');
  });

  it('a boot that never finishes stays starting, and the sweep settles it when it does', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(dto.state).toBe('starting');
    expect(await lifecycle.settleBoot(dto.id)).toBe('pending');
    fleet.completeBoot((await row(dto.id)).machineId!);
    expect((await sweeper.sweep()).settled).toBe(1);
    expect((await row(dto.id)).state).toBe('running');
    expect(await lifecycle.settleBoot(dto.id)).toBe('noop');
  });

  it('a boot whose machine vanishes fails, and a describe that throws leaves it pending', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    const spy = vi.spyOn(fleet, 'describePersistent').mockRejectedValueOnce(new Error('api down'));
    expect(await lifecycle.settleBoot(dto.id)).toBe('pending');
    spy.mockRestore();
    fleet.destroyOutside((await row(dto.id)).machineId!);
    expect(await lifecycle.settleBoot(dto.id)).toBe('failed');
    expect((await intervals())[0]).toMatchObject({ endReason: 'lost' });
  });

  it('a stop the provider refuses leaves it hibernating for the sweep; a machine gone mid-stop fails it', async () => {
    const dto = await create();
    fleet.failNextStop();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect((await row(dto.id)).state).toBe('hibernating');
    const spy = vi.spyOn(fleet, 'describePersistent').mockRejectedValueOnce(new Error('api down'));
    expect(await lifecycle.settleStop(dto.id)).toBe('pending');
    spy.mockRestore();
    expect(await lifecycle.settleStop(dto.id)).toBe('pending'); // still running on the host
    fleet.destroyOutside((await row(dto.id)).machineId!);
    expect(await lifecycle.settleStop(dto.id)).toBe('failed');
    expect(await lifecycle.settleStop(dto.id)).toBe('noop');
  });

  it('beginHibernate on an agent that is not running does nothing', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect(await lifecycle.beginHibernate(dto.id, 'idle')).toBe(false);
    expect(await lifecycle.beginHibernate('no-such-agent', 'idle')).toBe(false);
  });

  it('delete refuses a state it cannot leave, and settleDelete of an unknown id is a no-op', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    await expect(lifecycle.delete(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
    expect(await lifecycle.settleDelete('no-such-agent')).toBe('noop');
  });

  it('an agent whose machine was never created (a failed provision) can be woken only with a handle, and deleted', async () => {
    fleet.failNextProvision();
    const dto = await create();
    expect(dto.state).toBe('failed');
    await expect(lifecycle.wake(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    expect((await row(dto.id)).deletedAt).not.toBeNull();
  });

  it('the reconcile leaves a healthy machine alone and a describe failure changes nothing', async () => {
    const dto = await create();
    expect(await lifecycle.reconcileRunning(dto.id)).toBe('ok');
    const spy = vi.spyOn(fleet, 'describePersistent').mockRejectedValueOnce(new Error('api down'));
    expect(await lifecycle.reconcileRunning(dto.id)).toBe('noop');
    spy.mockRestore();
    expect(await lifecycle.reconcileRunning('no-such-agent')).toBe('noop');
  });

  it('the running charge rolls nothing inside the first minute or off a running agent, and a failed charge waits for the sweep', async () => {
    const dto = await create();
    expect(await lifecycle.rollInterval(dto.id)).toBe('noop');
    expect(await lifecycle.rollInterval('no-such-agent')).toBe('noop');
    clock.advance(5 * MIN);
    const spy = vi
      .spyOn(agentInstanceChargeService, 'chargeInterval')
      .mockRejectedValueOnce(new Error('boom'));
    expect(await lifecycle.rollInterval(dto.id)).toBe('rolled');
    spy.mockRestore();
    const [rolled] = await intervals();
    expect(rolled).toMatchObject({ endReason: 'rolled', chargeOutcome: 'pending' });
    expect((await sweeper.sweep()).charges.charged).toBe(1);
  });

  it('touchActivity of an unknown agent, or one not running, arms no timer', async () => {
    await lifecycle.touchActivity('no-such-agent');
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const before = await adminDb.jobQueueRun.count({
      where: { jobId: 'agent-instance/idle-check' },
    });
    await lifecycle.touchActivity(dto.id);
    expect(await adminDb.jobQueueRun.count({ where: { jobId: 'agent-instance/idle-check' } })).toBe(
      before,
    );
  });

  it('a close that races another close charges nothing twice', async () => {
    const dto = await create();
    clock.advance(2 * MIN);
    await Promise.all([
      lifecycle.beginHibernate(dto.id, 'idle'),
      lifecycle.beginHibernate(dto.id, 'backstop'),
    ]);
    await lifecycle.settleStop(dto.id);
    expect((await intervals()).filter((i) => i.endedAt !== null)).toHaveLength(1);
    expect(debits()).toHaveLength(1);
  });

  it('the charge answers noop for an unknown interval and records motir-ai being unconfigured', async () => {
    expect(await agentInstanceChargeService.chargeInterval('no-such-interval')).toEqual({
      outcome: 'noop',
    });
    const dto = await create();
    clock.advance(3 * MIN);
    vi.stubEnv('MOTIR_AI_URL', '');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect((await intervals())[0]).toMatchObject({
      chargeOutcome: 'not_charged',
      chargeDetail: 'motir-ai is not configured',
    });
    expect(debits()).toEqual([]);
  });

  it('a lost machine’s interval is metered as reaped and still charged', async () => {
    const dto = await create();
    clock.advance(4 * MIN);
    fleet.destroyOutside((await row(dto.id)).machineId!);
    expect((await sweeper.sweep()).reconciled).toBe(1);
    expect((await intervals())[0]).toMatchObject({ endReason: 'lost', chargeOutcome: 'charged' });
  });

  it('a step that throws is counted, never fatal, and the rest of the pass still runs', async () => {
    await create('one');
    const spy = vi
      .spyOn(lifecycle, 'reconcileRunning')
      .mockRejectedValueOnce(new Error('one step exploded'));
    const summary = await sweeper.sweep();
    spy.mockRestore();
    expect(summary.errors).toBe(1);
  });

  it('the charge backstop counts every outcome it records', async () => {
    const dto = await create();
    stub.debit = 'unavailable';
    clock.advance(2 * MIN);
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    let summary = await sweeper.sweep();
    expect(summary.charges.retryable).toBe(1);
    vi.stubEnv('MOTIR_CLOUD', '');
    summary = await sweeper.sweep();
    expect(summary.charges.notCharged).toBe(1);
  });

  it('checkIdle hibernates at the 12-hour backstop, and reports noop when the hibernate loses a race', async () => {
    const dto = await create();
    clock.advance(12 * 60 * MIN);
    await lifecycle.touchActivity(dto.id);
    const spy = vi.spyOn(lifecycle, 'beginHibernate').mockResolvedValueOnce(false);
    expect(await sweeper.checkIdle(dto.id)).toBe('noop');
    spy.mockRestore();
    expect(await sweeper.checkIdle(dto.id)).toBe('backstop');
  });

  it('checkIdle reports noop when an idle hibernate loses a race', async () => {
    const dto = await create();
    clock.advance(31 * MIN);
    const spy = vi.spyOn(lifecycle, 'beginHibernate').mockResolvedValueOnce(false);
    expect(await sweeper.checkIdle(dto.id)).toBe('noop');
    spy.mockRestore();
  });

  it('a young orphan volume is kept until it is 15 minutes old', async () => {
    await create();
    const orphan = await fleet.provisionPersistent({
      ...fleet.persistentSpecs[0]!,
      instanceId: 'orphan',
      env: { MOTIR_INSTANCE_ID: 'orphan' },
    });
    await fleet.destroyMachine(orphan.app, orphan.machineId);
    expect((await sweeper.sweep()).orphans).toEqual({ machines: 0, volumes: 0 });
  });

  it('the list counts an interval begun before this month only from the month’s start', async () => {
    const dto = await create();
    const [open] = await intervals();
    await adminDb.agentInstanceInterval.update({
      where: { id: open!.id },
      data: { startedAt: new Date('2026-08-31T23:00:00.000Z') },
    });
    const rows = (await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx)).instances;
    const mine = rows.find((r) => r.id === dto.id)!;
    // 10:00 on the 29th is 28 days and 10 hours into September.
    expect(mine.machineSecondsThisMonth).toBe((28 * 24 + 10) * 3600);
  });
});

describe('3b · the edges, staged in the database', () => {
  /** An agent row with NO machine handle and no interval, in the given state. */
  async function bareAgent(state: 'running' | 'starting' | 'hibernated', name = 'bare') {
    return adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        projectId: fx.projectId,
        ownerId: fx.ownerId,
        name,
        profileId: 'claude',
        imageTag: 'ghcr.io/moooon-b-v/motir-sandbox:claude',
        imageDigest: 'sha256:0',
        region: 'iad',
        state,
      },
    });
  }

  it('an agent with no machine handle: nothing to stop, boot, reconcile or roll', async () => {
    const running = await bareAgent('running');
    expect(await lifecycle.reconcileRunning(running.id)).toBe('noop');
    expect(await lifecycle.rollInterval(running.id)).toBe('noop');
    expect(await lifecycle.beginHibernate(running.id, 'idle')).toBe(true);
    const starting = await bareAgent('starting', 'bare-2');
    expect(await lifecycle.settleBoot(starting.id)).toBe('pending');
  });

  it('the list shows an agent with no intervals as no time and no credits', async () => {
    await bareAgent('hibernated');
    const [only] = (await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx)).instances;
    expect(only).toMatchObject({ machineSecondsThisMonth: 0, creditsThisMonth: 0 });
  });

  it('a stop instant before the interval’s start bills nothing rather than negative time', async () => {
    const dto = await create();
    const [open] = await intervals();
    await adminDb.agentInstanceInterval.update({
      where: { id: open!.id },
      data: { startedAt: new Date('2026-09-29T11:00:00.000Z') },
    });
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect((await intervals())[0]).toMatchObject({
      billableSeconds: 0,
      chargeOutcome: 'not_charged',
    });
  });

  it('a create that fails in the database for another reason frees its slot and rethrows', async () => {
    const { agentInstanceRepository } = await import('@/lib/repositories/agentInstanceRepository');
    const spy = vi.spyOn(agentInstanceRepository, 'create').mockRejectedValueOnce('not an error');
    await expect(create('x')).rejects.toBe('not an error');
    spy.mockRestore();
    expect(await slots()).toEqual([]);
  });

  it('a provision that throws a non-Error still fails the agent in words', async () => {
    const spy = vi.spyOn(fleet, 'provisionPersistent').mockRejectedValueOnce('nope');
    const dto = await create();
    spy.mockRestore();
    expect(dto.state).toBe('failed');
    expect(dto.failureReason).toContain('unknown error');
  });

  it('checkIdle on a running agent with no open interval judges by activity alone', async () => {
    const running = await bareAgent('running');
    await adminDb.agentInstance.update({
      where: { id: running.id },
      data: { lastActivityAt: clock.now() },
    });
    expect(await sweeper.checkIdle(running.id)).toBe('active');
  });

  it('the sweep settles an agent left hibernating, and caches one credit answer per organisation', async () => {
    const a = await create('a');
    await create('b');
    fleet.failNextStop();
    await lifecycle.hibernate(KEY(), a.id, fx.ctx);
    // The provider refused the stop; the machine stops later on its own.
    fleet.stopOutside((await row(a.id)).machineId!);
    stub.mayRun = false;
    const summary = await sweeper.sweep();
    expect(summary.settled).toBe(1);
    expect(summary.hibernated.credits).toBe(1);
    expect(stub.calls.filter((c) => c.url.includes('agent-run-check'))).toHaveLength(3); // two creates + one cached sweep ask
  });

  it('the sweep counts nothing when its hibernates lose their races', async () => {
    const dto = await create();
    const spy = vi.spyOn(lifecycle, 'beginHibernate').mockResolvedValue(false);
    clock.advance(12 * 60 * MIN);
    expect((await sweeper.sweep()).hibernated).toEqual({ idle: 0, backstop: 0, credits: 0 });
    // Not at the backstop, but refused credits and then idle — still counted as nothing.
    await adminDb.agentInstanceInterval.updateMany({
      where: { agentInstanceId: dto.id, endedAt: null },
      data: { runStartedAt: clock.now() },
    });
    stub.mayRun = false;
    expect((await sweeper.sweep()).hibernated.credits).toBe(0);
    stub.mayRun = true;
    expect((await sweeper.sweep()).hibernated.idle).toBe(0);
    spy.mockRestore();
  });

  it('a step that throws a non-Error is counted too', async () => {
    await create();
    const spy = vi.spyOn(lifecycle, 'reconcileRunning').mockRejectedValueOnce('bad');
    expect((await sweeper.sweep()).errors).toBe(1);
    spy.mockRestore();
  });

  it('the orphan pass reads owners that have no machine or volume', async () => {
    const dto = await create();
    await adminDb.agentInstance.update({
      where: { id: dto.id },
      data: { machineId: null, volumeId: null, state: 'failed' },
    });
    clock.advance(20 * MIN);
    // The real machine and volume are now owned by nobody: both are orphans.
    const first = await sweeper.sweep();
    expect(first.orphans.machines).toBe(1);
  });

  it('the charge backstop counts a refusal', async () => {
    const dto = await create();
    stub.debit = 'unavailable';
    clock.advance(2 * MIN);
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    stub.debit = 'refused';
    expect((await sweeper.sweep()).charges.refused).toBe(1);
  });

  it('the charge treats a closed interval with no seconds as zero, and meters an agent with no machine by its id', async () => {
    const bare = await bareAgent('failed' as never);
    const id = crypto.randomUUID();
    await adminDb.agentInstanceInterval.create({
      data: {
        id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        agentInstanceId: bare.id,
        runId: id,
        runStartedAt: new Date('2026-09-29T09:00:00.000Z'),
        startedAt: new Date('2026-09-29T09:00:00.000Z'),
        endedAt: new Date('2026-09-29T09:02:00.000Z'),
        endReason: 'lost',
        billableSeconds: 120,
        chargeOutcome: 'pending',
        chargeReference: `agent-instance-interval:${id}`,
      },
    });
    expect(await agentInstanceChargeService.chargeInterval(id)).toMatchObject({
      outcome: 'charged',
      credits: 2,
    });
    const id2 = crypto.randomUUID();
    await adminDb.agentInstanceInterval.create({
      data: {
        id: id2,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        agentInstanceId: bare.id,
        runId: id2,
        runStartedAt: new Date('2026-09-29T09:05:00.000Z'),
        startedAt: new Date('2026-09-29T09:05:00.000Z'),
        endedAt: new Date('2026-09-29T09:05:00.000Z'),
        endReason: 'lost',
        billableSeconds: null,
        chargeOutcome: 'pending',
        chargeReference: `agent-instance-interval:${id2}`,
      },
    });
    expect(await agentInstanceChargeService.chargeInterval(id2)).toEqual({
      outcome: 'not_charged',
      reason: 'zero_seconds',
    });
  });
});
