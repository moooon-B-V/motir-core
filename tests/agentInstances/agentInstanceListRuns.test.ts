import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  endLineReason,
  isClosedRunInAgent,
  toAgentInstanceActiveRunDto,
  toAgentInstanceLastRunDto,
} from '@/lib/mappers/agentInstanceMappers';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import {
  AGENT_RUN_END_DETAIL,
  agentInstanceRunService,
} from '@/lib/services/agentInstanceRunService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MY AGENTS SHOWS THE AGENT'S LIVE RUN — the read half (Story MOTIR-6864 ·
// MOTIR-7029, `design/my-agents/design-notes.md` § _The agent's live run_),
// against a real Postgres. Each listed agent carries `activeRun` (the run line)
// and, once that run has closed, `lastRun` (the "Last run" face with the reason
// the end path RECORDED) — read for the whole list in a bounded number of
// queries, never one per agent.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedAgent(name: string): Promise<string> {
  const row = await adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId!,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name,
      profileId: 'claude',
      imageTag: 't',
      imageDigest: 'sha256:x',
      region: 'iad',
      state: 'running',
    },
  });
  return row.id;
}

async function seedCard(title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

async function openIn(agentInstanceId: string, key: string) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      origin: 'instance',
      agentInstanceId,
      agent: 'claude',
      cards: [{ key, disposition: 'queued' }],
    },
    fx.ctx,
  );
  return run;
}

const list = async () =>
  new Map(
    (await lifecycle.list(fx.projectIdentifier, { take: 50, skip: 0 }, fx.ctx)).instances.map(
      (i) => [i.name, i],
    ),
  );

function bound<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, fn);
}

describe('the list carries each agent’s run', () => {
  it('an agent with a running run carries it — the card’s key and title, and when it started; an idle one carries neither', async () => {
    const busy = await seedAgent('busy');
    await seedAgent('idle');
    const key = await seedCard('The run section names the agent it ran in');
    const run = await openIn(busy, key);

    const rows = await list();
    expect(rows.get('busy')!.activeRun).toEqual({
      id: run.id,
      workItemKey: key,
      title: 'The run section names the agent it ran in',
      startedAt: run.startedAt,
    });
    expect(rows.get('busy')!.lastRun).toBeNull();
    expect(rows.get('idle')!.activeRun).toBeNull();
    expect(rows.get('idle')!.lastRun).toBeNull();
  });

  it('once the run closes the active run gives way to the LAST run: a success names its title and no reason', async () => {
    const agent = await seedAgent('yue-claude');
    const key = await seedCard('Ship it');
    const run = await openIn(agent, key);
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fx.ctx);

    const row = (await list()).get('yue-claude')!;
    expect(row.activeRun).toBeNull();
    expect(row.lastRun).toMatchObject({
      id: run.id,
      workItemKey: key,
      title: 'Ship it',
      status: 'succeeded',
      reason: null,
    });
    expect(row.lastRun!.endedAt).not.toBeNull();
  });

  it('a run the end path closed carries the reason it RECORDED, verbatim', async () => {
    const agent = await seedAgent('yue-claude');
    const key = await seedCard('Stops midway');
    const run = await openIn(agent, key);
    await agentInstanceRunService.end(run.id, 'failed', AGENT_RUN_END_DETAIL.agentStopped);

    const row = (await list()).get('yue-claude')!;
    expect(row.lastRun).toMatchObject({
      id: run.id,
      status: 'failed',
      reason: AGENT_RUN_END_DETAIL.agentStopped,
    });
  });

  it('a failure the CLI closed itself records no reason, so none is invented', async () => {
    const agent = await seedAgent('yue-claude');
    const run = await openIn(agent, await seedCard('Halts'));
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);
    expect((await list()).get('yue-claude')!.lastRun).toMatchObject({
      status: 'failed',
      reason: null,
      title: 'Halts',
    });
  });

  it('the LATEST run is the one shown: a newer run replaces the older one’s line', async () => {
    const agent = await seedAgent('yue-claude');
    const first = await openIn(agent, await seedCard('First'));
    await agentInstanceRunService.end(first.id, 'failed', AGENT_RUN_END_DETAIL.agentStopped);
    const second = await openIn(agent, await seedCard('Second'));

    let row = (await list()).get('yue-claude')!;
    expect(row.activeRun?.id).toBe(second.id);
    expect(row.lastRun).toBeNull();

    await dispatchRunService.close(second.id, { stopReason: 'completed' }, fx.ctx);
    row = (await list()).get('yue-claude')!;
    expect(row.lastRun).toMatchObject({ id: second.id, title: 'Second', status: 'succeeded' });
  });

  it('reads the whole list in a BOUNDED number of queries, whatever the count of agents', async () => {
    const spies = [
      vi.spyOn(dispatchRunRepository, 'findRunningByAgentInstances'),
      vi.spyOn(dispatchRunRepository, 'findLatestByAgentInstances'),
      vi.spyOn(dispatchRunRepository, 'findTargetCards'),
      vi.spyOn(dispatchRunEventRepository, 'listEndLinesForRuns'),
    ];
    const perAgent = vi.spyOn(dispatchRunRepository, 'findRunningByAgentInstance');
    const measure = async () => {
      for (const spy of [...spies, perAgent]) spy.mockClear();
      await list();
      return spies.map((s) => s.mock.calls.length);
    };

    const a = await seedAgent('a');
    await openIn(a, await seedCard('A'));
    const one = await measure();

    for (const name of ['b', 'c', 'd', 'e']) {
      const id = await seedAgent(name);
      const run = await openIn(id, await seedCard(name));
      if (name !== 'b') {
        await agentInstanceRunService.end(run.id, 'failed', AGENT_RUN_END_DETAIL.agentStopped);
      }
    }
    const five = await measure();

    expect(five).toEqual(one);
    expect(five.every((n) => n === 1)).toBe(true);
    expect(perAgent).not.toHaveBeenCalled();
  });
});

describe('the reads, directly', () => {
  it('the latest run per agent is ONE row per agent, whatever its status; an agent that never ran is absent', async () => {
    const a = await seedAgent('a');
    const b = await seedAgent('b');
    const never = await seedAgent('never');
    const a1 = await openIn(a, await seedCard('a1'));
    await dispatchRunService.close(a1.id, { stopReason: 'completed' }, fx.ctx);
    const a2 = await openIn(a, await seedCard('a2'));
    const b1 = await openIn(b, await seedCard('b1'));

    const rows = await bound((tx) =>
      dispatchRunRepository.findLatestByAgentInstances([a, b, never], tx),
    );
    const byAgent = new Map(rows.map((r) => [r.agentInstanceId, r]));
    expect(rows).toHaveLength(2);
    expect(byAgent.get(a)).toMatchObject({ id: a2.id, status: 'running', endedAt: null });
    expect(byAgent.get(b)!.id).toBe(b1.id);
    expect(byAgent.get(a)!.startedAt).toBeInstanceOf(Date);
    expect(await bound((tx) => dispatchRunRepository.findLatestByAgentInstances([], tx))).toEqual(
      [],
    );
  });

  it('a run’s target card is its scope when it has one, else its first leg; a deleted card keeps its key', async () => {
    const agent = await seedAgent('a');
    const key = await seedCard('Leg card');
    const legRun = await openIn(agent, key);
    await dispatchRunService.close(legRun.id, { stopReason: 'completed' }, fx.ctx);

    const scopeKey = await seedCard('The scope');
    const scoped = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        scopeKey,
        cards: [],
      },
      fx.ctx,
    );
    const bare = await dispatchRunService.open(
      { projectKey: fx.projectIdentifier, command: 'run', cards: [] },
      fx.ctx,
    );

    let targets = await bound((tx) =>
      dispatchRunRepository.findTargetCards([legRun.id, scoped.run.id, bare.run.id], tx),
    );
    expect(targets.get(legRun.id)).toEqual({ workItemKey: key, title: 'Leg card' });
    expect(targets.get(scoped.run.id)).toEqual({ workItemKey: scopeKey, title: 'The scope' });
    expect(targets.has(bare.run.id)).toBe(false);

    await adminDb.workItem.deleteMany({ where: { identifier: key } });
    targets = await bound((tx) => dispatchRunRepository.findTargetCards([legRun.id], tx));
    expect(targets.get(legRun.id)).toEqual({ workItemKey: key, title: null });
    expect(await bound((tx) => dispatchRunRepository.findTargetCards([], tx))).toEqual(new Map());
  });

  it('the closing lines of several runs, newest first; none asked, none read', async () => {
    const agent = await seedAgent('a');
    const run = await openIn(agent, await seedCard('x'));
    await agentInstanceRunService.end(run.id, 'failed', AGENT_RUN_END_DETAIL.machineLost);
    const lines = await bound((tx) => dispatchRunEventRepository.listEndLinesForRuns([run.id], tx));
    expect(lines).toHaveLength(1);
    expect(endLineReason(lines[0]!.data)).toBe(AGENT_RUN_END_DETAIL.machineLost);
    expect(await bound((tx) => dispatchRunEventRepository.listEndLinesForRuns([], tx))).toEqual([]);
  });
});

describe('the mappers', () => {
  const started = new Date('2026-09-30T10:00:00.000Z');
  const ended = new Date('2026-09-30T10:30:00.000Z');

  it('maps the active run, with or without its card', () => {
    expect(
      toAgentInstanceActiveRunDto(
        { id: 'r1', startedAt: started },
        { workItemKey: 'MOTIR-1', title: 'T' },
      ),
    ).toEqual({ id: 'r1', workItemKey: 'MOTIR-1', title: 'T', startedAt: started.toISOString() });
    expect(toAgentInstanceActiveRunDto({ id: 'r1', startedAt: started }, null)).toEqual({
      id: 'r1',
      workItemKey: null,
      title: null,
      startedAt: started.toISOString(),
    });
  });

  it('maps the last run: a success drops the reason, a failure keeps it; no card, no key', () => {
    const base = { id: 'r', agentInstanceId: 'a', startedAt: started };
    expect(
      toAgentInstanceLastRunDto(
        { ...base, status: 'succeeded', endedAt: ended },
        { workItemKey: 'MOTIR-1', title: 'T' },
        'ignored',
      ),
    ).toEqual({
      id: 'r',
      workItemKey: 'MOTIR-1',
      title: 'T',
      status: 'succeeded',
      endedAt: ended.toISOString(),
      reason: null,
    });
    expect(
      toAgentInstanceLastRunDto({ ...base, status: 'timed_out', endedAt: null }, null, 'stalled'),
    ).toEqual({
      id: 'r',
      workItemKey: null,
      title: null,
      status: 'timed_out',
      endedAt: null,
      reason: 'stalled',
    });
  });

  it('only a closed run is a last run', () => {
    const base = { id: 'r', agentInstanceId: 'a', startedAt: started, endedAt: null };
    expect(isClosedRunInAgent({ ...base, status: 'running' })).toBe(false);
    expect(isClosedRunInAgent({ ...base, status: 'cancelled' })).toBe(true);
  });

  it('reads a recorded reason only from a non-empty string `message`', () => {
    expect(endLineReason({ end: 'failed', message: 'the agent stopped' })).toBe(
      'the agent stopped',
    );
    expect(endLineReason({ end: 'failed', message: '  ' })).toBeNull();
    expect(endLineReason({ end: 'failed', message: 7 })).toBeNull();
    expect(endLineReason({ end: 'failed' })).toBeNull();
    expect(endLineReason(null)).toBeNull();
    expect(endLineReason('x')).toBeNull();
    expect(endLineReason(['x'])).toBeNull();
  });
});
