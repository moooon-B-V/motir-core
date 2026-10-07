import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApprovalGateKind,
  ApprovalGateState,
  User,
  WorkItem,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { ContinueFromInvalidError } from '@/lib/dispatchRuns/errors';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { usersService } from '@/lib/services/usersService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';

// A GATED RUN RESUMES THROUGH THE CONTINUE DOOR (Story MOTIR-7701 · MOTIR-7708).
//
// A run that stopped at a gate closed `gated` — it SUCCEEDED, so before this card
// the continue claim answered `no_dead_run` and `continueFrom` refused it as
// `succeeded`. Now, once a gate it stopped on is approved, the same claim takes it
// over on its own branch, with the same lock and the same parent split as a run
// that died; while every gate still waits it refuses `gate_awaiting`, and when the
// gates were sent back it refuses `gate_sent_back`. Over real Postgres.

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

/** A gate on `card` and the held-gate row naming it on `runId`. */
async function hold(
  fx: WorkItemFixture,
  runId: string,
  card: WorkItem,
  state: ApprovalGateState,
  kind: ApprovalGateKind = 'design_result',
): Promise<string> {
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      kind,
      subjectId: `subject-${randomToken()}`,
      state,
      ...(state === 'awaiting' ? {} : { decidedById: fx.ownerId, decidedAt: new Date() }),
    },
  });
  await adminDb.dispatchRunHeldGate.create({
    data: {
      workspaceId: fx.workspaceId,
      dispatchRunId: runId,
      gateId: gate.id,
      workItemId: card.id,
      kind,
    },
  });
  return gate.id;
}

/** An In Progress task whose one run checked out a branch and closed `gated`. */
async function gatedCard(fx: WorkItemFixture) {
  const card = await createTestWorkItem(fx, {
    kind: 'task',
    title: 'a card that stopped at a gate',
  });
  await setStatus(card.id, 'in_progress');
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  const branch = `subtask/${card.identifier}-work`;
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
  await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
  return { card, runId: run.id, branch };
}

/** A story whose SCOPE run closed `gated`: one leg landed, one in flight, and a
 *  design leg whose gate held the run. */
async function gatedStory(fx: WorkItemFixture) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
  const sub = (title: string) =>
    createTestWorkItem(fx, { kind: 'subtask', title, parentId: story.id });
  const design = await sub('the design');
  const landed = await sub('landed');
  const code = await sub('the code');
  await setStatus(story.id, 'in_progress');
  await setStatus(design.id, 'in_progress');
  await setStatus(landed.id, 'implemented');
  await setStatus(code.id, 'in_progress');
  for (const id of [story.id, design.id, landed.id, code.id]) {
    await adminDb.workItem.update({ where: { id }, data: { assigneeId: fx.ownerId } });
  }
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run_scope',
      reportedBy: 'cli',
      scopeKey: story.identifier,
      cards: [design, landed, code].map((c) => ({
        key: c.identifier,
        disposition: 'queued' as const,
      })),
    },
    fx.ctx,
  );
  const sessionBranch = 'motir/auto-20261007-0900';
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'card_settled',
        workItemKey: landed.identifier,
        disposition: 'integrated',
        sessionBranch,
      },
    ],
    fx.ctx,
  );
  await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
  return { story, design, landed, code, runId: run.id, sessionBranch };
}

describe('the verdict — what a gated run answers', () => {
  it('an APPROVED held gate makes it resumable: claimed on its own branch, as a resume', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId, branch } = await gatedCard(fx);
    await hold(fx, runId, card, 'approved');
    const other = await member(fx, 'Jo Pace');

    const result = await claim(fx, card.identifier, other.ctx);

    expect(result).toMatchObject({
      outcome: 'claimed',
      reason: null,
      branch,
      resumesGated: true,
      gates: [{ key: card.identifier, kind: 'design_result', state: 'approved' }],
      previousAssignee: { id: fx.ownerId },
      // The run it resumes is NOT rewritten as a death.
      deadRun: { id: runId, status: 'succeeded', stopReason: 'gated' },
    });
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: result.runId!, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      command: 'continue',
      continuesRunId: runId,
      resumesGated: true,
      gates: [{ key: card.identifier, kind: 'design_result', state: 'approved' }],
    });
    const gated = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(gated).toMatchObject({ status: 'succeeded', stopReason: 'gated' });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).assigneeId).toBe(
      other.user.id,
    );
  });

  it('a gated run that recorded NO held gate is resumable too', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await gatedCard(fx);

    const result = await claim(fx, card.identifier);

    expect(result).toMatchObject({ outcome: 'claimed', resumesGated: true, gates: [] });
  });

  it('every held gate still awaiting: gate_awaiting naming them, nothing written', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await gatedCard(fx);
    await hold(fx, runId, card, 'awaiting');
    await hold(fx, runId, card, 'awaiting', 'manual_work');

    const result = await claim(fx, card.identifier);

    expect(result).toMatchObject({ outcome: 'not_continuable', reason: 'gate_awaiting' });
    expect(result.gates.map((g) => g.kind).sort()).toEqual(['design_result', 'manual_work']);
    expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(0);
  });

  it.each(['changes_requested', 'declined', 'overturned'] as const)(
    'a gate %s and none approved: gate_sent_back',
    async (state) => {
      const fx = await makeWorkItemFixture();
      const { card, runId } = await gatedCard(fx);
      await hold(fx, runId, card, state);
      await hold(fx, runId, card, 'awaiting', 'manual_work');

      const result = await claim(fx, card.identifier);

      expect(result).toMatchObject({
        outcome: 'not_continuable',
        reason: 'gate_sent_back',
        gates: [{ key: card.identifier, kind: 'design_result', state }],
      });
    },
  );

  it('one approved among waiting ones is enough to resume', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await gatedCard(fx);
    await hold(fx, runId, card, 'awaiting', 'manual_work');
    await hold(fx, runId, card, 'changes_requested', 'decision_approval');
    await hold(fx, runId, card, 'approved');

    expect(await claim(fx, card.identifier)).toMatchObject({
      outcome: 'claimed',
      resumesGated: true,
    });
  });

  it('a gated run is NOT a death: the run-died marker draws nothing for it', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await gatedCard(fx);
    await hold(fx, runId, card, 'approved');

    expect(await workItemContinueService.getContinueView(card.id, fx.ctx)).toEqual({
      state: 'none',
    });
  });

  it('a run that died is still `died`, whatever gates exist', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'died' });
    await setStatus(card.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          disposition: 'running',
          data: { branch: 'b' },
        },
      ],
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);
    await hold(fx, run.id, card, 'awaiting');

    expect(await workItemContinueService.getContinueView(card.id, fx.ctx)).toMatchObject({
      state: 'died',
    });
    const result = await claim(fx, card.identifier);
    expect(result).toMatchObject({ outcome: 'claimed', resumesGated: false, gates: [] });
  });

  it('a status refusal still comes first: a gated card at Implemented is use_fix', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await gatedCard(fx);
    await hold(fx, runId, card, 'awaiting');
    await setStatus(card.id, 'implemented');

    expect(await claim(fx, card.identifier)).toMatchObject({ reason: 'use_fix' });
  });
});

describe('a gated PARENT run resumes like a dead one', () => {
  it('takes the scope over on the session branch, landed and resumed keys as for a death', async () => {
    const fx = await makeWorkItemFixture();
    const { story, design, landed, code, runId, sessionBranch } = await gatedStory(fx);
    await hold(fx, runId, design, 'approved');
    const other = await member(fx, 'Jo Pace');

    const result = await claim(fx, story.identifier, other.ctx);

    expect(result).toMatchObject({
      outcome: 'claimed',
      mode: 'parent',
      branch: sessionBranch,
      landedKeys: [landed.identifier],
      resumedKeys: [design.identifier, code.identifier].sort(),
      resumesGated: true,
      gates: [{ key: design.identifier, kind: 'design_result', state: 'approved' }],
    });
    const opened = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: result.runId! } });
    expect(opened).toMatchObject({ command: 'continue', scopeWorkItemId: story.id });
  });

  it('a leg is resumed with its parent, and the parent waits while its gate does', async () => {
    const fx = await makeWorkItemFixture();
    const { story, design, code, runId } = await gatedStory(fx);
    await hold(fx, runId, design, 'awaiting');

    expect(await claim(fx, code.identifier)).toMatchObject({
      reason: 'continue_the_parent',
      parentKey: story.identifier,
    });
    expect(await claim(fx, story.identifier)).toMatchObject({
      reason: 'gate_awaiting',
      gates: [{ key: design.identifier, kind: 'design_result', state: 'awaiting' }],
    });
  });

  it('two members racing on the resume: exactly one `claimed`, the other `taken`', async () => {
    const fx = await makeWorkItemFixture();
    const { story, design, runId } = await gatedStory(fx);
    await hold(fx, runId, design, 'approved');
    const a = await member(fx, 'Racer A');
    const b = await member(fx, 'Racer B');

    await warmPool(4);
    const results = await Promise.all([
      claim(fx, story.identifier, a.ctx),
      claim(fx, story.identifier, b.ctx),
    ]);

    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'taken')).toHaveLength(1);
    expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(1);
  });
});

describe('dispatch_prompt { continueFrom } on a gated run', () => {
  const prompt = (fx: WorkItemFixture, key: string, continueFrom: string) =>
    dispatchPromptService.getDispatchPrompt(fx.projectId, key, fx.ctx, { continueFrom });

  it('renders the RESUME block — after an approval, never a death', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId, branch } = await gatedCard(fx);
    await hold(fx, runId, card, 'approved');
    await hold(fx, runId, card, 'awaiting', 'manual_work');

    const dto = await prompt(fx, card.identifier, runId);

    expect(dto.branch).toBe(branch);
    expect(dto.prompt).not.toContain('DIED');
    expect(dto.prompt).not.toContain('stopped reporting');
    const start = dto.prompt.indexOf('RESUME —');
    const end = dto.prompt.indexOf('close the run `gated`.', start);
    expect(start).toBeGreaterThan(-1);
    const block = dto.prompt
      .slice(start, end + 'close the run `gated`.'.length)
      .split(card.identifier)
      .join('<KEY>')
      .split(runId)
      .join('<RUN>');
    expect(block).toMatchSnapshot();
  });

  it('refuses a gated run whose gates still wait, or were sent back', async () => {
    const fx = await makeWorkItemFixture();
    const awaiting = await gatedCard(fx);
    await hold(fx, awaiting.runId, awaiting.card, 'awaiting');
    const sentBack = await gatedCard(fx);
    await hold(fx, sentBack.runId, sentBack.card, 'changes_requested');

    for (const [seed, why] of [
      [awaiting, 'gate_awaiting'],
      [sentBack, 'gate_sent_back'],
    ] as const) {
      const err = await prompt(fx, seed.card.identifier, seed.runId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContinueFromInvalidError);
      expect((err as ContinueFromInvalidError).why).toBe(why);
    }
  });
});
