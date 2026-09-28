import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { usersService } from '@/lib/services/usersService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';

// THE CONTINUE CLAIM (Story MOTIR-6526 · MOTIR-6532) — `POST
// /api/v1/work-items/{key}/continue`, over real Postgres.
//
// What is under test: a work item whose last run DIED can be taken over by
// another member, on the dead run's branch; a lapsed run is closed `abandoned`
// in the same transaction; the item is RE-ASSIGNED and its STATUS never written;
// every refusal fires with its reason; and two claims racing on one item produce
// exactly one continuing agent. The race warms the pool first — on a cold pool
// the racers share one connection and pass with the lock missing.

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

const claim = (fx: WorkItemFixture, key: string, ctx: ServiceContext = fx.ctx) =>
  workItemContinueService.claimContinue(fx.projectId, key, ctx);

/** An In Progress task, assigned to the owner, with ONE local run over it that
 *  checked out `branch` and then went silent `silentMinutes` ago. */
async function deadCard(
  fx: WorkItemFixture,
  opts: { silentMinutes?: number; branch?: string | null; status?: string } = {},
) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: 'a card whose run died' });
  await setStatus(card.id, opts.status ?? 'in_progress');
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  const branch = opts.branch === undefined ? `subtask/${card.identifier}-work` : opts.branch;
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: card.identifier,
        disposition: 'running',
        data: { branch },
      },
    ],
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - (opts.silentMinutes ?? 7) * 60_000) },
  });
  return { card, runId: run.id, branch };
}

describe('claimContinue — the takeover', () => {
  it('a second member takes over a lapsed run: re-assigned, status unchanged, lapsed run closed, a continue run open', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId, branch } = await deadCard(fx);
    const other = await member(fx, 'Jo Pace');
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    const result = await claim(fx, card.identifier, other.ctx);

    expect(result).toMatchObject({
      key: card.identifier,
      outcome: 'claimed',
      reason: null,
      branch,
      holder: { id: other.user.id, name: 'Jo Pace' },
      previousAssignee: { id: fx.ownerId },
      deadRun: { id: runId, status: 'timed_out', stopReason: 'abandoned', origin: 'local' },
    });
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe(before.status);
    expect(after.assigneeId).toBe(other.user.id);

    const dead = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(dead).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
    const reason = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId: runId, kind: 'log' },
    });
    expect((reason?.data as { message: string }).message).toMatch(/^no heartbeat since /);

    const opened = await adminDb.dispatchRun.findUniqueOrThrow({
      where: { id: result.runId! },
      include: { cards: true },
    });
    expect(opened).toMatchObject({
      command: 'continue',
      status: 'running',
      createdById: other.user.id,
    });
    expect(opened.cards.map((c) => c.workItemId)).toEqual([card.id]);
    const event = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId: opened.id, kind: 'run_opened' },
    });
    expect(event?.data).toMatchObject({ continuesRunId: runId, branch });

    // The run's own read says what it resumes (MOTIR-6795) — what a hosted
    // container adopting it reads — and a run that is not a continue says null.
    expect((await dispatchRunService.getRun(result.runId!, other.ctx)).continues).toEqual({
      fromRunId: runId,
      branch,
      branches: [{ repository: null, branch, cloneUrl: null }],
      mode: 'card',
      landedKeys: [],
      resumedKeys: [],
    });
    expect((await dispatchRunService.getRun(runId, fx.ctx)).continues).toBeNull();
  });

  it('prefers the OPEN pull request’s head over the recorded branch', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx, { branch: 'subtask/recorded' });
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/the-pr-head',
      baseRef: 'main',
      checks: {},
    });

    const result = await claim(fx, card.identifier);

    expect(result.branch).toBe('subtask/the-pr-head');
    expect(result.pullRequest).toEqual({
      repo: `acme/${repo.name}`,
      number: pr.number,
      url: `https://github.com/acme/${repo.name}/pull/${pr.number}`,
      headRef: 'subtask/the-pr-head',
    });
  });

  it('the claimant’s own repeat answers `mine` with the same run and the branch again', async () => {
    const fx = await makeWorkItemFixture();
    const { card, branch } = await deadCard(fx);
    const first = await claim(fx, card.identifier);
    const again = await claim(fx, card.identifier);
    expect(again).toMatchObject({ outcome: 'mine', runId: first.runId, branch });
  });

  it('a continue that ITSELF dies can be continued again — it becomes the dead run', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const first = await claim(fx, card.identifier);
    await adminDb.dispatchRun.update({
      where: { id: first.runId! },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    const other = await member(fx, 'Second Helper');

    const second = await claim(fx, card.identifier, other.ctx);

    expect(second.outcome).toBe('claimed');
    expect(second.deadRun?.id).toBe(first.runId);
    expect(second.deadRun?.command).toBe('continue');
  });
});

describe('claimContinue — the race', () => {
  it('two members racing on one item: exactly one `claimed`, the other `taken` naming the first', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const a = await member(fx, 'Racer A');
    const b = await member(fx, 'Racer B');

    await warmPool(4);
    const results = await Promise.all([
      claim(fx, card.identifier, a.ctx),
      claim(fx, card.identifier, b.ctx),
    ]);

    const winners = results.filter((r) => r.outcome === 'claimed');
    const losers = results.filter((r) => r.outcome === 'taken');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.runId).toBe(winners[0]!.runId);
    expect(losers[0]!.holder?.id).toBe(winners[0]!.holder?.id);
    expect(losers[0]!.branch).toBeNull();
    const continues = await adminDb.dispatchRun.findMany({
      where: { command: 'continue', cards: { some: { workItemId: card.id } } },
    });
    expect(continues).toHaveLength(1);
  });
});

describe('claimContinue — every refusal, with its reason', () => {
  it('run_alive — a run that heartbeat a minute ago, naming its dispatcher; nothing written', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await deadCard(fx, { silentMinutes: 1 });
    const other = await member(fx, 'Too Early');

    const result = await claim(fx, card.identifier, other.ctx);

    expect(result).toMatchObject({
      outcome: 'not_continuable',
      reason: 'run_alive',
      holder: { id: fx.ownerId },
    });
    expect((await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      'running',
    );
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).assigneeId).toBe(
      fx.ownerId,
    );
  });

  it('no_dead_run — the only run succeeded', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await deadCard(fx);
    await dispatchRunService.close(runId, { stopReason: 'completed' }, fx.ctx);
    expect((await claim(fx, card.identifier)).reason).toBe('no_dead_run');
  });

  it('no_dead_run — never run at all', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'never run' });
    await setStatus(card.id, 'in_progress');
    expect((await claim(fx, card.identifier)).reason).toBe('no_dead_run');
  });

  it('no_branch — a dead run that recorded no branch', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx, { branch: null });
    expect((await claim(fx, card.identifier)).reason).toBe('no_branch');
  });

  it('use_fix — the item is at Implemented', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx, { status: 'implemented' });
    expect((await claim(fx, card.identifier)).reason).toBe('use_fix');
  });

  it('not_in_progress — the item is at To Do', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx, { status: 'todo' });
    expect((await claim(fx, card.identifier)).reason).toBe('not_in_progress');
  });

  it('continue_the_parent — a dead PARENT run’s leg, naming the parent', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child',
      parentId: story.id,
    });
    await setStatus(child.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        scopeKey: story.identifier,
        cards: [{ key: child.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);

    const result = await claim(fx, child.identifier);

    expect(result).toMatchObject({ reason: 'continue_the_parent', parentKey: story.identifier });
  });

  it('not_in_progress — a To Do leg of a dead parent run has nothing to continue, and the card shows nothing (MOTIR-6537)', async () => {
    // Found by `how-to-test.spec`: a never-started child of a dead scoped run was
    // offered `motir continue <PARENT>`, against the design's not-shown rule.
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child never started',
      parentId: story.id,
    });
    await setStatus(child.id, 'todo');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        scopeKey: story.identifier,
        cards: [{ key: child.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);

    expect(await claim(fx, child.identifier)).toMatchObject({ reason: 'not_in_progress' });
    expect(await workItemContinueService.getContinueView(child.id, fx.ctx)).toMatchObject({
      state: 'died',
      refusal: 'not_in_progress',
    });
  });
});

describe('getContinueView — the four states the marker renders', () => {
  it('none · alive · died · continuing', async () => {
    const fx = await makeWorkItemFixture();
    const never = await createTestWorkItem(fx, { kind: 'task', title: 'never' });
    expect(await workItemContinueService.getContinueView(never.id, fx.ctx)).toEqual({
      state: 'none',
    });

    const alive = await deadCard(fx, { silentMinutes: 1 });
    expect(await workItemContinueService.getContinueView(alive.card.id, fx.ctx)).toEqual({
      state: 'alive',
    });

    const died = await deadCard(fx);
    const view = await workItemContinueService.getContinueView(died.card.id, fx.ctx);
    expect(view).toMatchObject({
      state: 'died',
      branch: died.branch,
      refusal: null,
      deadRun: { id: died.runId, status: 'running' },
    });
    // A READ: the lapsed run is not closed by looking at it.
    expect(
      (await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: died.runId } })).status,
    ).toBe('running');

    const other = await member(fx, 'Jo Pace');
    await claim(fx, died.card.identifier, other.ctx);
    expect(await workItemContinueService.getContinueView(died.card.id, fx.ctx)).toMatchObject({
      state: 'continuing',
      holder: { id: other.user.id },
      byViewer: false,
      branch: died.branch,
      tookOverFrom: { runId: died.runId, dispatcher: { id: fx.ownerId } },
    });
    expect(await workItemContinueService.getContinueView(died.card.id, other.ctx)).toMatchObject({
      state: 'continuing',
      byViewer: true,
    });
  });

  it('died with the claim’s refusal carried, so the page never offers a command the claim refuses', async () => {
    const fx = await makeWorkItemFixture();
    const impl = await deadCard(fx, { status: 'implemented' });
    expect(await workItemContinueService.getContinueView(impl.card.id, fx.ctx)).toMatchObject({
      state: 'died',
      refusal: 'use_fix',
    });
    const bare = await deadCard(fx, { branch: null });
    expect(await workItemContinueService.getContinueView(bare.card.id, fx.ctx)).toMatchObject({
      state: 'died',
      refusal: 'no_branch',
    });
  });
});

describe('the branch is read from EITHER checkout_ready shape', () => {
  it('reads `data.branches[0].branch` (the per-repository shape) as well as `data.branch`', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await deadCard(fx, { branch: null });
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { dispatchRunId: runId } });
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        dispatchRunCardId: leg.id,
        seq: 99,
        kind: 'checkout_ready',
        data: {
          branches: [
            {
              repository: 'motir-core',
              branch: 'subtask/per-repo',
              workBranch: 'subtask/per-repo',
            },
          ],
        },
      },
    });
    expect((await claim(fx, card.identifier)).branch).toBe('subtask/per-repo');
  });
  it('an event carrying BOTH shapes keeps every repository, the scalar naming the primary’s (MOTIR-6793)', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await deadCard(fx, { branch: null });
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { dispatchRunId: runId } });
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        dispatchRunCardId: leg.id,
        seq: 99,
        kind: 'checkout_ready',
        data: {
          // What a continue's leg wrote before MOTIR-6793: the dead branch in the
          // scalar, the card's fresh branch in `branches[0]`.
          branch: 'subtask/the-dead-one',
          branches: [
            { repository: 'motir-core', branch: 'subtask/fresh', workBranch: 'subtask/fresh' },
            { repository: 'motir-ai', branch: 'subtask/ai', workBranch: 'subtask/ai' },
          ],
        },
      },
    });
    const result = await claim(fx, card.identifier);
    expect(result.branch).toBe('subtask/the-dead-one');
    expect(result.branches.map((b) => [b.repository, b.branch])).toEqual([
      ['motir-core', 'subtask/the-dead-one'],
      ['motir-ai', 'subtask/ai'],
    ]);
  });
});

describe('claimContinue — a PARENT whose scope run died (MOTIR-6535)', () => {
  it('takes the whole scope over on the session branch and names what already landed', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    const landed = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'first',
      parentId: story.id,
    });
    const inFlight = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'second',
      parentId: story.id,
    });
    const waiting = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'third',
      parentId: story.id,
    });
    await setStatus(story.id, 'in_progress');
    await setStatus(landed.id, 'implemented');
    await setStatus(inFlight.id, 'in_progress');
    for (const id of [story.id, landed.id, inFlight.id]) {
      await adminDb.workItem.update({ where: { id }, data: { assigneeId: fx.ownerId } });
    }
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        scopeKey: story.identifier,
        cards: [landed, inFlight, waiting].map((c) => ({
          key: c.identifier,
          disposition: 'queued' as const,
        })),
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'card_settled',
          workItemKey: landed.identifier,
          disposition: 'integrated',
          sessionBranch: 'motir/auto-20260927-0900',
        },
      ],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 8 * 60_000) },
    });
    const other = await member(fx, 'Jo Pace');

    const result = await claim(fx, story.identifier, other.ctx);

    expect(result).toMatchObject({
      outcome: 'claimed',
      mode: 'parent',
      branch: 'motir/auto-20260927-0900',
      landedKeys: [landed.identifier],
      // The in-flight leg is named, so the resumed drain runs it again — the ready
      // set lists only To Do leaves. The never-started one is left to the ready set.
      resumedKeys: [inFlight.identifier],
      deadRun: { id: run.id, stopReason: 'abandoned' },
    });
    // The container AND its in-flight leg are the claimant's now; the landed one
    // and the never-started one are untouched; no status moved.
    const rows = await adminDb.workItem.findMany({
      where: { id: { in: [story.id, landed.id, inFlight.id, waiting.id] } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(story.id)).toMatchObject({ assigneeId: other.user.id, status: 'in_progress' });
    expect(byId.get(inFlight.id)).toMatchObject({
      assigneeId: other.user.id,
      status: 'in_progress',
    });
    expect(byId.get(landed.id)).toMatchObject({ assigneeId: fx.ownerId, status: 'implemented' });
    // The continue run is scoped to the container and carries the dead run's legs.
    const opened = await adminDb.dispatchRun.findUniqueOrThrow({
      where: { id: result.runId! },
      include: { cards: { orderBy: { position: 'asc' } } },
    });
    expect(opened).toMatchObject({ command: 'continue', scopeWorkItemId: story.id });
    expect(opened.cards.map((c) => c.workItemKey)).toEqual([
      landed.identifier,
      inFlight.identifier,
      waiting.identifier,
    ]);
    expect(await workItemContinueService.getContinueView(story.id, fx.ctx)).toMatchObject({
      state: 'continuing',
    });
    expect((await dispatchRunService.getRun(result.runId!, other.ctx)).continues).toMatchObject({
      fromRunId: run.id,
      branch: 'motir/auto-20260927-0900',
      mode: 'parent',
      landedKeys: [landed.identifier],
      resumedKeys: [inFlight.identifier],
    });
  });
});

// A HOSTED opening (Story MOTIR-6527 · MOTIR-6790): the claim opens the lock AS
// the hosted run, so the browser's Continue hosted and a terminal `motir
// continue` race on ONE row.
describe('claimContinue — a hosted opening', () => {
  const opening = (idempotencyKey: string) => ({
    origin: 'hosted' as const,
    agent: 'opencode' as const,
    model: 'anthropic/claude-sonnet-5',
    idempotencyKey,
  });
  const hostedClaim = (
    fx: WorkItemFixture,
    key: string,
    idempotencyKey: string,
    ctx: ServiceContext = fx.ctx,
  ) =>
    workItemContinueService.claimContinue(fx.projectId, key, ctx, new Date(), {
      opening: opening(idempotencyKey),
    });

  it('opens ONE hosted `continue` run with its agent, model and key, and ONE `run_opened` saying so', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId, branch } = await deadCard(fx);
    const key = `hosted-${randomToken()}`;

    const result = await hostedClaim(fx, card.identifier, key);

    expect(result).toMatchObject({ outcome: 'claimed', branch, deadRun: { id: runId } });
    const opened = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: result.runId! } });
    expect(opened).toMatchObject({
      command: 'continue',
      origin: 'hosted',
      agent: 'opencode',
      model: 'anthropic/claude-sonnet-5',
      idempotencyKey: key,
      status: 'running',
    });
    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: opened.id, kind: 'run_opened' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBe(1);
    expect(events[0]!.data).toMatchObject({
      continuesRunId: runId,
      branch,
      origin: 'hosted',
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it('the same key again answers the same run and opens nothing — even once that run has ended', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await deadCard(fx);
    const key = `hosted-${randomToken()}`;
    const first = await hostedClaim(fx, card.identifier, key);

    const again = await hostedClaim(fx, card.identifier, key);
    expect(again).toMatchObject({
      outcome: 'claimed',
      runId: first.runId,
      branch: first.branch,
      deadRun: { id: runId },
      previousAssignee: first.previousAssignee,
    });

    // The boot failed after the claim: the end path closed the run. A retried
    // start with the SAME key is still told which run it opened, not handed a
    // second takeover.
    await dispatchRunService.close(first.runId!, { stopReason: 'halted' }, fx.ctx);
    const afterEnd = await hostedClaim(fx, card.identifier, key);
    expect(afterEnd.runId).toBe(first.runId);

    const continues = await adminDb.dispatchRun.findMany({
      where: { command: 'continue', cards: { some: { workItemId: card.id } } },
    });
    expect(continues).toHaveLength(1);
  });

  it('a DIFFERENT key while the hosted continue is alive is refused `taken`, naming its holder', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const first = await hostedClaim(fx, card.identifier, `hosted-${randomToken()}`);
    const other = await member(fx, 'Terminal User');

    const fromTerminal = await claim(fx, card.identifier, other.ctx);
    const fromBrowser = await hostedClaim(
      fx,
      card.identifier,
      `hosted-${randomToken()}`,
      other.ctx,
    );

    for (const answer of [fromTerminal, fromBrowser]) {
      expect(answer).toMatchObject({
        outcome: 'taken',
        runId: first.runId,
        holder: { id: fx.ownerId },
      });
    }
  });

  it('a key that names some OTHER run is refused as a duplicate, not replayed', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const key = `hosted-${randomToken()}`;
    const unrelated = await createTestWorkItem(fx, { kind: 'task', title: 'unrelated' });
    await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        idempotencyKey: key,
        cards: [{ key: unrelated.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );

    await expect(hostedClaim(fx, card.identifier, key)).rejects.toMatchObject({
      name: 'DuplicateDispatchRunError',
    });
  });

  it('every refusal answers before any run is opened, opening or not', async () => {
    const fx = await makeWorkItemFixture();
    const alive = await deadCard(fx, { silentMinutes: 1 });
    const fix = await deadCard(fx, { status: 'implemented' });
    const todo = await deadCard(fx, { status: 'todo' });
    const bare = await deadCard(fx, { branch: null });
    const succeeded = await deadCard(fx);
    await dispatchRunService.close(succeeded.runId, { stopReason: 'completed' }, fx.ctx);

    const cases: Array<[string, string]> = [
      [alive.card.identifier, 'run_alive'],
      [fix.card.identifier, 'use_fix'],
      [todo.card.identifier, 'not_in_progress'],
      [bare.card.identifier, 'no_branch'],
      [succeeded.card.identifier, 'no_dead_run'],
    ];
    for (const [key, reason] of cases) {
      const answer = await hostedClaim(fx, key, `hosted-${randomToken()}`);
      expect(answer).toMatchObject({ outcome: 'not_continuable', reason, runId: null });
    }
    expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(0);
  });

  it('continue_the_parent is refused before any run is opened, with an opening', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child',
      parentId: story.id,
    });
    await setStatus(child.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        scopeKey: story.identifier,
        cards: [{ key: child.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);

    const answer = await hostedClaim(fx, child.identifier, `hosted-${randomToken()}`);

    expect(answer).toMatchObject({ reason: 'continue_the_parent', parentKey: story.identifier });
    expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(0);
  });
});

// A dead run's branch PER REPOSITORY (Story MOTIR-6527 · MOTIR-6791).
describe('claimContinue — a run across repositories', () => {
  async function twoRepoDeadCard(fx: WorkItemFixture) {
    const { card, runId } = await deadCard(fx, { branch: null });
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { targetRepo: 'web', targetRepos: ['web', 'core'] },
    });
    await dispatchRunService.appendEvents(
      runId,
      [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          data: {
            branches: [
              { repository: 'core', branch: 'task/core-side', workBranch: 'task/core-side' },
              { repository: 'web', branch: 'task/web-side', workBranch: 'task/web-side' },
            ],
          },
        },
      ],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { lastHeartbeatAt: new Date(Date.now() - 7 * 60_000) },
    });
    return { card, runId };
  }

  it('the claim and the view carry EVERY repository’s branch, the primary’s first and as `branch`', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await twoRepoDeadCard(fx);

    const view = await workItemContinueService.getContinueView(card.id, fx.ctx);
    expect(view).toMatchObject({
      state: 'died',
      branch: 'task/web-side',
      branches: [
        { repository: 'web', branch: 'task/web-side', pullRequest: null },
        { repository: 'core', branch: 'task/core-side', pullRequest: null },
      ],
    });

    const result = await claim(fx, card.identifier);
    expect(result).toMatchObject({
      outcome: 'claimed',
      branch: 'task/web-side',
      branches: [
        { repository: 'web', branch: 'task/web-side' },
        { repository: 'core', branch: 'task/core-side' },
      ],
    });

    // The continue itself records both, so a continue that dies before its own
    // checkout is continuable across both repositories again.
    const continuing = await workItemContinueService.getContinueView(card.id, fx.ctx);
    expect(continuing).toMatchObject({
      state: 'continuing',
      branches: [
        { repository: 'web', branch: 'task/web-side' },
        { repository: 'core', branch: 'task/core-side' },
      ],
    });
    await adminDb.dispatchRun.update({
      where: { id: result.runId! },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    const again = await claim(fx, card.identifier);
    expect(again.branches.map((b) => b.branch)).toEqual(['task/web-side', 'task/core-side']);
  });

  it('the continue run’s read gives each branch its repository’s clone URL, where the project knows one (MOTIR-6795)', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await twoRepoDeadCard(fx);
    await connectRepairRepo(fx, 'core');

    const result = await claim(fx, card.identifier);
    const run = await dispatchRunService.getRun(result.runId!, fx.ctx);
    expect(run.continues?.branches).toEqual([
      { repository: 'web', branch: 'task/web-side', cloneUrl: null },
      {
        repository: 'core',
        branch: 'task/core-side',
        cloneUrl: expect.stringMatching(/acme\/core/),
      },
    ]);
  });

  it('an open pull request in ONE repository replaces only that repository’s branch', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await twoRepoDeadCard(fx);
    const core = await connectRepairRepo(fx, 'core');
    await deliveredPr(fx, card.id, core, { headRef: 'task/core-pr', checks: {} });

    const result = await claim(fx, card.identifier);

    expect(result.branches).toEqual([
      { repository: 'web', branch: 'task/web-side', pullRequest: null },
      {
        repository: 'core',
        branch: 'task/core-pr',
        pullRequest: expect.objectContaining({ repo: 'acme/core', headRef: 'task/core-pr' }),
      },
    ]);
    expect(result.branch).toBe('task/web-side');
  });

  it('a one-repository run answers a one-element `branches`', async () => {
    const fx = await makeWorkItemFixture();
    const { card, branch } = await deadCard(fx);
    const result = await claim(fx, card.identifier);
    expect(result.branches).toEqual([{ repository: null, branch, pullRequest: null }]);
  });
});
