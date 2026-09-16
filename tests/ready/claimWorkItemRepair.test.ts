import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { usersService } from '@/lib/services/usersService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';

// The REPAIR CLAIM (Story MOTIR-5460 · MOTIR-5464) — `POST
// /api/v1/work-items/{key}/repair`, over real Postgres.
//
// What is under test: ONE fixing agent at a time on an `implemented` card's red
// pull requests, a refusal for every case where a repair makes no sense, and —
// the property the whole design rests on — the card's status and assignee are
// never written. The race tests warm the pool first; on a cold pool the racers
// share one connection and pass with the lock missing.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function member(
  fx: WorkItemFixture,
  name: string,
): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** An `implemented` task with ONE open, failing pull request. */
async function redCard(fx: WorkItemFixture, title = 'red card') {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  await setStatus(card.id, 'implemented');
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, card.id, repo, {
    headRef: 'subtask/red-card',
    baseRef: 'main',
    checks: { Vitest: 'failure', Lint: 'success' },
  });
  return { card, repo, pr };
}

const claim = (fx: WorkItemFixture, key: string, ctx: ServiceContext = fx.ctx) =>
  workItemRepairService.claimRepair(fx.projectId, key, ctx);

async function fixRuns(workItemId: string) {
  return adminDb.dispatchRun.findMany({
    where: { command: 'fix', cards: { some: { workItemId } } },
    orderBy: { startedAt: 'asc' },
  });
}

describe('claimRepair — the claim', () => {
  it('claims an implemented card with one failing PR, and writes neither status nor assignee', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await redCard(fx);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    const result = await claim(fx, card.identifier);

    expect(result).toMatchObject({
      key: card.identifier,
      title: 'red card',
      outcome: 'claimed',
      reason: null,
      runTargetKey: null,
      holder: { id: fx.ownerId },
    });
    expect(result.runId).toEqual(expect.any(String));
    expect(result.startedAt).toEqual(expect.any(String));
    expect(result.pullRequests).toEqual([
      {
        repo: `acme/${repo.name}`,
        number: pr.number,
        url: `https://github.com/acme/${repo.name}/pull/${pr.number}`,
        headRef: 'subtask/red-card',
        baseRef: 'main',
        ci: 'failing',
        failingChecks: ['Vitest'],
      },
    ]);

    // Read the row BACK: the repair is a run, not a status move.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('implemented');
    expect(after.assigneeId).toBe(before.assigneeId);
    expect(after.updatedAt).toEqual(before.updatedAt);

    const runs = await fixRuns(card.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: result.runId, status: 'running', createdById: fx.ownerId });
  });

  it('hands over only the failing OPEN pull requests, and ignores a merged one that is red', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo } = await redCard(fx);
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/green',
      checks: { Vitest: 'success' },
    });
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/merged-red',
      checks: { Vitest: 'failure' },
      state: 'closed',
      merged: true,
    });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests.map((p) => p.headRef)).toEqual(['subtask/red-card']);
  });

  it('a pull request mirrored before base branches were recorded is handed over with a null base', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { baseRef: null } });

    const result = await claim(fx, card.identifier);

    expect(result.pullRequests[0]?.baseRef).toBeNull();
  });
});

describe('claimRepair — the refusals, in order', () => {
  it.each(['todo', 'in_review', 'in_progress', 'done'])(
    'a card at `%s` is not_implemented',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const { card } = await redCard(fx);
      await setStatus(card.id, status);

      const result = await claim(fx, card.identifier);

      expect(result).toMatchObject({
        outcome: 'not_repairable',
        reason: 'not_implemented',
        runId: null,
        holder: null,
        startedAt: null,
        pullRequests: [],
      });
      expect(await fixRuns(card.id)).toHaveLength(0);
    },
  );

  it('an ARCHIVED implemented card is not_implemented', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    await adminDb.workItem.update({ where: { id: card.id }, data: { archivedAt: new Date() } });

    const result = await claim(fx, card.identifier);

    expect(result.reason).toBe('not_implemented');
    expect(await fixRuns(card.id)).toHaveLength(0);
  });

  it('a project with no status keyed `implemented` has nothing to repair, even on an in-progress-category card', async () => {
    // The rung is resolved by KEY, so a workflow without the status never reads a
    // plain in-progress card as implemented through the category fallback.
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    await setStatus(card.id, 'in_progress');
    await adminDb.workflowStatus.deleteMany({
      where: { projectId: fx.projectId, key: 'implemented' },
    });

    expect((await claim(fx, card.identifier)).reason).toBe('not_implemented');
  });

  it('a CHILD of a run target is repair_on_run_target, naming that target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child',
      parentId: story.id,
    });
    await setStatus(child.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    // The same pull request delivers the child as well as the story.
    await deliveredPr(fx, child.id, repo, { headRef: 'parent/x', checks: { Vitest: 'failure' } });
    await testInstructionsService.publish(
      {
        workItemId: story.id,
        bodyMd: '## Precondition\n\nSign in.',
        previewPath: null,
        repos: [{ repoId: repo.id, commitSha: 'c'.repeat(40) }],
      },
      fx.ctx,
    );

    const result = await claim(fx, child.identifier);

    expect(result).toMatchObject({
      outcome: 'not_repairable',
      reason: 'repair_on_run_target',
      runTargetKey: story.identifier,
      pullRequests: [],
    });
    expect(await fixRuns(child.id)).toHaveLength(0);
  });

  it('an implemented card with no deliveries is no_pull_requests', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'no PRs' });
    await setStatus(card.id, 'implemented');

    expect(await claim(fx, card.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'no_pull_requests',
    });
  });

  it('nothing failing and one member running is ci_running', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'running' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, card.id, repo, { headRef: 'a', checks: { Vitest: 'pending' } });
    await deliveredPr(fx, card.id, repo, { headRef: 'b', checks: { Vitest: 'success' } });

    expect((await claim(fx, card.identifier)).reason).toBe('ci_running');
  });

  it('nothing failing and nothing running is not_failing — passing, no CI at all, or red only on a closed PR', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'green' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, card.id, repo, { headRef: 'a', checks: { Vitest: 'success' } });
    await deliveredPr(fx, card.id, repo, { headRef: 'b' });
    await deliveredPr(fx, card.id, repo, {
      headRef: 'c',
      checks: { Vitest: 'failure' },
      state: 'closed',
    });

    expect((await claim(fx, card.identifier)).reason).toBe('not_failing');
    expect(await fixRuns(card.id)).toHaveLength(0);
  });
});

describe('claimRepair — who holds it', () => {
  it('a second person is refused as taken, naming the holder and the start, and handed nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const first = await claim(fx, card.identifier);
    const rival = await member(fx, 'Rival Runner');

    const second = await claim(fx, card.identifier, rival.ctx);

    expect(second).toMatchObject({
      outcome: 'taken',
      reason: null,
      runId: first.runId,
      holder: { id: fx.ownerId, name: fx.owner.name },
      startedAt: first.startedAt,
      pullRequests: [],
    });
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('the holder claiming again is mine, with the same run and the branches again', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const first = await claim(fx, card.identifier);

    const again = await claim(fx, card.identifier);

    expect(again.outcome).toBe('mine');
    expect(again.runId).toBe(first.runId);
    expect(again.pullRequests).toEqual(first.pullRequests);
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('once the run is closed, a new claim opens a NEW run', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const first = await claim(fx, card.identifier);
    await dispatchRunService.close(first.runId!, { stopReason: 'halted' }, fx.ctx);

    const next = await claim(fx, card.identifier);

    expect(next.outcome).toBe('claimed');
    expect(next.runId).not.toBe(first.runId);
    expect(await fixRuns(card.id)).toHaveLength(2);
  });

  it('the refusal order holds for a held repair too: a card that left `implemented` is not_implemented, not taken', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    await claim(fx, card.identifier);
    await setStatus(card.id, 'in_review');
    const rival = await member(fx, 'Rival Runner');

    expect((await claim(fx, card.identifier, rival.ctx)).reason).toBe('not_implemented');
  });
});

describe('claimRepair — real concurrency (warm pool)', () => {
  it('N genuinely concurrent claims on one card yield EXACTLY ONE run', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const racers = await Promise.all(Array.from({ length: 5 }, (_, i) => member(fx, `Racer ${i}`)));
    const contexts = [fx.ctx, ...racers.map((r) => r.ctx)];

    await warmPool(contexts.length + 2);
    const results = await Promise.all(contexts.map((ctx) => claim(fx, card.identifier, ctx)));

    const winners = results.filter((r) => r.outcome === 'claimed');
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'taken')).toHaveLength(contexts.length - 1);
    for (const loser of results.filter((r) => r.outcome === 'taken')) {
      expect(loser.runId).toBe(winners[0]!.runId);
      expect(loser.holder?.id).toBe(winners[0]!.holder?.id);
    }
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('the SAME caller racing itself resolves to one claimed and one mine', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);

    await warmPool();
    const results = await Promise.all([claim(fx, card.identifier), claim(fx, card.identifier)]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['claimed', 'mine']);
    expect(await fixRuns(card.id)).toHaveLength(1);
  });
});

describe('claimRepair — access', () => {
  it('a key in another workspace is not found, and nothing is opened', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await makeWorkItemFixture({ name: 'Rival Co', identifier: 'ZZZ' });
    const { card } = await redCard(fx);

    await expect(claim(fx, card.identifier, outsider.ctx)).rejects.toMatchObject({
      code: 'WORK_ITEM_NOT_FOUND',
    });
    expect(await fixRuns(card.id)).toHaveLength(0);
  });

  it('a member who may browse the project but not edit it is refused, and nothing is opened', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const reader = await member(fx, 'Read Only');
    const role = await projectRoleDefinitionService.create({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Browse only',
      permissions: ['project:browse'],
    });
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: reader.user.id,
      role: 'member',
    });
    await projectMembersService.setRole({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: reader.user.id,
      role: role.id,
    });
    // The reader CAN see the card — the refusal below is the edit gate, not tenancy.
    await expect(
      workItemsService.getWorkItemByIdentifier(fx.projectId, card.identifier, reader.ctx),
    ).resolves.toMatchObject({ id: card.id });

    await expect(claim(fx, card.identifier, reader.ctx)).rejects.toMatchObject({
      code: expect.stringMatching(/DENIED/),
    });
    expect(await fixRuns(card.id)).toHaveLength(0);
  });
});
