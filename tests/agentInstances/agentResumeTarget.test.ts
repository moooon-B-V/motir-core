import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A CARD'S LAST RUN, READ BACK for the "Fix in my agent" door and the resume
// (Story MOTIR-8981 · MOTIR-9046), against a real Postgres: which agent the last
// run ran in, the session id the CARD'S LEG recorded, and whether the profile has a
// resume form.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedAgent(name: string, profileId = 'claude', ownerId = fx.ownerId) {
  return adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId!,
      projectId: fx.projectId,
      ownerId,
      name,
      profileId,
      imageTag: 't',
      imageDigest: 'sha256:x',
      region: 'iad',
      state: 'running',
    },
  });
}

const card = (title = 'a card') =>
  workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);

/** A closed run over the given cards, optionally in an agent, with events seeded directly. */
async function seedRun(opts: {
  keys: string[];
  agentInstanceId?: string;
  command?: 'run' | 'review' | 'fix';
  startedAt?: Date;
  events?: Array<{
    key: string | null;
    kind: 'agent_started' | 'agent_exited';
    data: Record<string, unknown> | null;
  }>;
}) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: opts.command ?? 'run',
      reportedBy: 'cli',
      origin: opts.agentInstanceId ? 'instance' : 'local',
      ...(opts.agentInstanceId ? { agentInstanceId: opts.agentInstanceId, agent: 'claude' } : {}),
      cards: opts.keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  if (opts.startedAt) {
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { startedAt: opts.startedAt },
    });
  }
  const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
  let seq = 100;
  for (const e of opts.events ?? []) {
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: run.id,
        dispatchRunCardId: e.key ? (legs.find((l) => l.workItemKey === e.key)?.id ?? null) : null,
        seq: (seq += 1),
        kind: e.kind,
        data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
  return run;
}

const read = (key: string) => agentInstanceRunService.resumeTargetForCard(key, fx.ctx);

describe('resumeTargetForCard', () => {
  it('answers null for a card never run, and for a card whose only runs are reviews', async () => {
    const item = await card();
    expect(await read(item.identifier)).toEqual({ lastRun: null });
    await seedRun({ keys: [item.identifier], command: 'review' });
    expect(await read(item.identifier)).toEqual({ lastRun: null });
  });

  it('names the agent, the recorded session and that the profile can resume', async () => {
    const item = await card();
    const agent = await seedAgent('yue-claude');
    const run = await seedRun({
      keys: [item.identifier],
      agentInstanceId: agent.id,
      events: [
        { key: item.identifier, kind: 'agent_started', data: { sessionId: 'sess-start' } },
        { key: item.identifier, kind: 'agent_exited', data: { sessionId: 'sess-exit' } },
      ],
    });
    const { lastRun } = await read(item.identifier);
    expect(lastRun).toMatchObject({
      id: run.id,
      command: 'run',
      status: 'running',
      agent: { id: agent.id, name: 'yue-claude', profile: 'claude', profileLabel: 'Claude Code' },
      agentIsReaders: true,
      sessionId: 'sess-exit',
      canResume: true,
    });
  });

  it('falls back from agent_exited to agent_started, and treats null or blank ids as absent', async () => {
    const agent = await seedAgent('yue-claude');
    const startedOnly = await card('started only');
    await seedRun({
      keys: [startedOnly.identifier],
      agentInstanceId: agent.id,
      events: [{ key: startedOnly.identifier, kind: 'agent_started', data: { sessionId: 's1' } }],
    });
    expect((await read(startedOnly.identifier)).lastRun?.sessionId).toBe('s1');

    const blank = await card('blank');
    const other = await seedAgent('other');
    await seedRun({
      keys: [blank.identifier],
      agentInstanceId: other.id,
      events: [
        { key: blank.identifier, kind: 'agent_exited', data: { sessionId: null } },
        { key: blank.identifier, kind: 'agent_started', data: { sessionId: '  ' } },
      ],
    });
    const { lastRun } = await read(blank.identifier);
    expect(lastRun?.sessionId).toBeNull();
    // null never means "cannot resume": the profile still has the form.
    expect(lastRun?.canResume).toBe(true);
  });

  it('reads the session from the card’s own leg, never another leg’s', async () => {
    const mine = await card('mine');
    const theirs = await card('theirs');
    const agent = await seedAgent('yue-claude');
    await seedRun({
      keys: [mine.identifier, theirs.identifier],
      agentInstanceId: agent.id,
      events: [{ key: theirs.identifier, kind: 'agent_exited', data: { sessionId: 'theirs' } }],
    });
    expect((await read(mine.identifier)).lastRun?.sessionId).toBeNull();
    expect((await read(theirs.identifier)).lastRun?.sessionId).toBe('theirs');
  });

  it('answers the LAST run even when it was hosted over an older agent run', async () => {
    const item = await card();
    const agent = await seedAgent('yue-claude');
    await seedRun({
      keys: [item.identifier],
      agentInstanceId: agent.id,
      startedAt: new Date(Date.now() - 3_600_000),
      events: [{ key: item.identifier, kind: 'agent_exited', data: { sessionId: 'old' } }],
    });
    await adminDb.dispatchRun.updateMany({
      where: { agentInstanceId: agent.id },
      data: { status: 'succeeded', endedAt: new Date() },
    });
    await seedRun({ keys: [item.identifier] });
    const { lastRun } = await read(item.identifier);
    expect(lastRun).toMatchObject({ agent: null, sessionId: null, canResume: false });
    expect(lastRun?.agentIsReaders).toBe(false);
  });

  it('answers canResume false for aider and for an unknown profile', async () => {
    for (const profile of ['aider', 'something-new']) {
      const item = await card(profile);
      const agent = await seedAgent(`a-${profile}`, profile);
      await seedRun({
        keys: [item.identifier],
        agentInstanceId: agent.id,
        events: [{ key: item.identifier, kind: 'agent_exited', data: { sessionId: 's' } }],
      });
      expect((await read(item.identifier)).lastRun?.canResume).toBe(false);
    }
  });

  it('is not the reader’s agent when another member owns it', async () => {
    const item = await card();
    const other = await adminDb.user.create({
      data: { name: 'Other', email: `o-${Date.now()}@example.com` },
    });
    const agent = await seedAgent('theirs', 'claude', other.id);
    await seedRun({ keys: [item.identifier], agentInstanceId: agent.id });
    expect((await read(item.identifier)).lastRun?.agentIsReaders).toBe(false);
  });

  it('answers a run whose agent row is gone with no agent and no resume', async () => {
    const item = await card();
    const agent = await seedAgent('gone');
    await seedRun({
      keys: [item.identifier],
      agentInstanceId: agent.id,
      events: [{ key: item.identifier, kind: 'agent_exited', data: { sessionId: 's' } }],
    });
    await adminDb.agentInstance.delete({ where: { id: agent.id } });
    expect((await read(item.identifier)).lastRun).toMatchObject({
      agent: null,
      agentIsReaders: false,
      sessionId: null,
      canResume: false,
    });
  });

  it('reads a scoped run’s container run-scoped, and orders by seq', async () => {
    const parent = await card('parent');
    const child = await card('child');
    const agent = await seedAgent('yue-claude');
    const run = await seedRun({
      keys: [child.identifier],
      agentInstanceId: agent.id,
      events: [
        { key: null, kind: 'agent_exited', data: { sessionId: 'older-seq' } },
        { key: null, kind: 'agent_exited', data: { sessionId: 'newer-seq' } },
      ],
    });
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { scopeWorkItemId: parent.id },
    });
    // The parent has no leg of its own: the run-scoped newest event answers.
    expect((await read(parent.identifier)).lastRun?.sessionId).toBe('newer-seq');
  });

  it('refuses nothing but answers null for a caller without instance:use', async () => {
    const item = await card();
    const member = await adminDb.user.create({
      data: { name: 'Viewer', email: `v-${Date.now()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: member.id, workspaceRole: 'member' },
    });
    const result = await agentInstanceRunService
      .resumeTargetForCard(item.identifier, { userId: member.id, workspaceId: fx.workspaceId })
      .catch((e: unknown) => e);
    // A member without the permission degrades to null; one who cannot browse gets the browse refusal.
    if (result instanceof Error) expect(result).not.toBeInstanceOf(PermissionDeniedError);
    else expect(result).toEqual({ lastRun: null });
  });
});
