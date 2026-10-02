import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { AGENT_BOOT_POLL_MS } from '@/lib/agentInstances/config';
import { isJobRunDefer, type JobRunDefer } from '@/lib/jobs/engine/defer';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { agentInstanceBoot } from '@/lib/jobs/definitions/agentInstanceBoot';
import { agentInstanceBootService as boot } from '@/lib/services/agentInstanceBootService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import type { AgentInstanceBootData } from '@/lib/jobs/types';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { clock, fleet, fx, seedRepo, setUpHarness, tearDownHarness } from './_harness';

// THE `agent-instance/boot` JOB (Story MOTIR-7393 · MOTIR-7398): its declaration —
// one driver per attempt, no retries — and its handler driven as the engine
// drives it: a pass that must wait for the machine DEFERS the same run, and the
// run that holds the lease (`ctx.runId`) keeps it across its deferred passes.

beforeEach(async () => {
  await setUpHarness();
  await seedRepo('acme', 'web');
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function openedBoot(): Promise<AgentInstanceBootData & { machineId: string }> {
  fleet.setBootBehaviour('never_start');
  const dto = await lifecycle.create(
    fx.projectIdentifier,
    { name: 'yue-claude', profileId: 'claude' },
    fx.ctx,
  );
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: dto.id } });
  const { attempt, event } = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    boot.start(row, 'create', tx),
  );
  await boot.recordProvision(row, attempt, null);
  return { ...event, machineId: row.machineId! };
}

async function runPass(data: AgentInstanceBootData, runId: string): Promise<unknown> {
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  return engineJob('agent-instance/boot')!.handler(
    { step, runId, attempt: 1, event: { data } } as never,
    jobServices as never,
  );
}

describe('the agent-instance/boot job', () => {
  it('is declared once per attempt, with no retry', () => {
    expect(agentInstanceBoot.id).toBe('agent-instance/boot');
    const def = engineJob('agent-instance/boot')!;
    expect(def.trigger).toBe('agent-instance/boot');
    expect(def.retryPolicy).toBe('none');
    expect(def.maxAttempts).toBe(1);
    expect(def.idempotency).toBe('event.data.idempotencyKey');
  });

  it('defers while the machine starts, then finishes the boot under the same run', async () => {
    const data = await openedBoot();
    const deferred = await runPass(data, 'job-run-1').catch((err: unknown) => err);
    expect(isJobRunDefer(deferred)).toBe(true);
    expect((deferred as JobRunDefer).resumeAt).toEqual(
      new Date(clock.now().getTime() + AGENT_BOOT_POLL_MS),
    );
    const held = await adminDb.agentInstanceBootAttempt.findFirstOrThrow({
      where: { agentInstanceId: data.instanceId },
    });
    expect(held.leaseHolder).toBe('job-run-1');

    // A second delivery while the first run holds the lease ends at once.
    expect(await runPass(data, 'job-run-2')).toBe('done');

    fleet.completeBoot(data.machineId);
    clock.advance(AGENT_BOOT_POLL_MS);
    expect(await runPass(data, 'job-run-1')).toBe('done');
    const agent = await adminDb.agentInstance.findUniqueOrThrow({
      where: { id: data.instanceId },
    });
    expect(agent.state).toBe('running');
    const closed = await adminDb.agentInstanceBootAttempt.findFirstOrThrow({
      where: { agentInstanceId: data.instanceId },
    });
    expect(closed).toMatchObject({ outcome: 'running', leaseHolder: null });
  });
});
