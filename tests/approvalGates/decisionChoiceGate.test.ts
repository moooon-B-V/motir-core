import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { decisionChoiceGateHandler } from '@/lib/approvalGates/decisionChoiceHandler';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';
import { summarizeGateSubjects } from '@/lib/approvalGates/subjectSummary';
import { choiceGateService } from '@/lib/services/choiceGateService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE `decision_choice` KIND (Story MOTIR-4914 · Subtask MOTIR-5891; ADR
// `approval-gates.md` §1's MOTIR-5887 amendment, points 3, 5, 6). Real Postgres,
// through the real service funnels: a choice is RAISED from its own body when it
// has no open blocker, walked to review by declared edges, re-asked at a new
// stamp on an edit, withdrawn when it stops being a choice — and a `decision`
// work item of either executor never raises it.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const COMPLETE = [
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** better than your decision',
  '**You said:** "Keep them in Postgres."',
  'Research found a cheaper store.',
  '## Options',
  '### Managed object storage',
  '**Best if you want:** less to operate',
  'The provider runs it.',
  '### Our own Postgres',
  '**Best if you want:** more cost-effective',
  'No new vendor.',
  '## What this choice gates',
  'The export story.',
].join('\n');

async function createChoice(
  descriptionMd: string,
  extra: {
    type?: 'choice' | 'decision';
    executor?: 'human' | 'coding_agent';
    blockedBy?: string;
  } = {},
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Choose ${seq}`,
      type: extra.type ?? 'choice',
      executor: extra.executor ?? 'human',
      descriptionMd,
      ...(extra.blockedBy
        ? { links: [{ relationship: 'blocked_by', targetId: extra.blockedBy }] }
        : {}),
    },
    fx.ctx,
  );
}

function choiceGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'decision_choice' },
    orderBy: { createdAt: 'asc' },
  });
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

describe('the raise — a complete, unblocked choice is asked', () => {
  it('raises an awaiting gate at the body’s stamp, routed, and walks the item to review', async () => {
    const item = await createChoice(COMPLETE);
    const gates = await choiceGates(item.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectId: item.id,
      routedToId: fx.ownerId,
    });
    expect(gates[0]!.subjectVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(item.status).toBe('in_review');
  });

  it('a defective body raises nothing, and the item page carries the defect reasons', async () => {
    const defective = COMPLETE.replace('**Best if you want:** more cost-effective\n', '');
    const item = await createChoice(defective);
    expect(await choiceGates(item.id)).toHaveLength(0);
    expect(await statusOf(item.id)).toBe('todo');

    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);
    expect(detail.choiceBody).toMatchObject({
      ok: false,
      defects: [{ reason: 'option_without_best_for', label: 'Our own Postgres' }],
    });
    // The overlay port has nothing to pick from.
    expect(await choiceGateService.readPort(item.id, fx.ctx)).toBeNull();
  });

  it('the item page carries the parsed options for a complete body', async () => {
    const item = await createChoice(COMPLETE);
    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);
    expect(detail.choiceBody?.ok).toBe(true);
    if (detail.choiceBody?.ok) {
      expect(detail.choiceBody.port.options.map((o) => o.id)).toEqual([
        'managed-object-storage',
        'our-own-postgres',
      ]);
      expect(detail.choiceBody.port.why.situation).toBe('better_than_your_decision');
    }
  });

  it('a `decision` work item of EITHER executor raises no choice gate, whatever its body', async () => {
    const human = await createChoice(COMPLETE, { type: 'decision', executor: 'human' });
    const agent = await createChoice(COMPLETE, { type: 'decision', executor: 'coding_agent' });
    expect(await choiceGates(human.id)).toHaveLength(0);
    expect(await choiceGates(agent.id)).toHaveLength(0);
    const detail = await workItemsService.getIssueDetail(fx.projectId, human.identifier, fx.ctx);
    expect(detail.choiceBody).toBeNull();
  });
});

describe('blockers — a choice waiting on something is asked when it lands', () => {
  it('is not asked while blocked, and is asked when its last open blocker reaches done', async () => {
    seq += 1;
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `Research ${seq}`, type: 'research' },
      fx.ctx,
    );
    const item = await createChoice(COMPLETE, { blockedBy: blocker.id });
    expect(await choiceGates(item.id)).toHaveLength(0);

    await workItemsService.updateStatus(blocker.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(blocker.id, 'done', fx.ctx);

    const gates = await choiceGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['awaiting']);
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('an edit — the stamp decides whether the question is asked again', () => {
  it('editing the options supersedes the awaiting gate and raises one at the new stamp', async () => {
    const item = await createChoice(COMPLETE);
    const [first] = await choiceGates(item.id);

    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: COMPLETE.replace('No new vendor.', 'No new vendor, no new bill.') },
      fx.ctx,
    );

    const gates = await choiceGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded', 'awaiting']);
    expect(gates[0]!.supersededCause).toBe('republished');
    expect(gates[1]!.subjectVersion).not.toBe(first!.subjectVersion);
  });

  it('rewording only the question keeps the same gate', async () => {
    const item = await createChoice(COMPLETE);
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: COMPLETE.replace('Where do exported', 'Where should exported') },
      fx.ctx,
    );
    expect((await choiceGates(item.id)).map((g) => g.state)).toEqual(['awaiting']);
  });

  it('a redelivered reconcile raises nothing new — idempotent on the stamp', async () => {
    const item = await createChoice(COMPLETE);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    const again = await withWorkspaceContext(fx.ctx, (tx) => choiceGateService.reconcile(row, tx));
    expect(again).toEqual({ raised: false, superseded: 0, hopsToReview: [] });
    expect(await choiceGates(item.id)).toHaveLength(1);
  });

  it('a body that stops parsing withdraws the question and raises none', async () => {
    const item = await createChoice(COMPLETE);
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: COMPLETE.replace(/## What this choice gates[\s\S]*$/, '') },
      fx.ctx,
    );
    expect((await choiceGates(item.id)).map((g) => g.state)).toEqual(['superseded']);
  });

  it('changing the type off `choice` withdraws the question', async () => {
    const item = await createChoice(COMPLETE);
    await workItemsService.updateWorkItem(item.id, { type: 'decision' }, fx.ctx);
    const gates = await choiceGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded']);
    expect(gates[0]!.supersededCause).toBe('withdrawn');
  });
});

describe('the handler — choose writes done; an option the subject lacks is refused', () => {
  async function decideWith(workItemId: string, optionId: string | undefined) {
    const [gate] = await choiceGates(workItemId);
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
    return withWorkspaceContext(fx.ctx, (tx) =>
      decisionChoiceGateHandler.approve({
        gate: gate!,
        item,
        ctx: fx.ctx,
        tx,
        resolvedStatusKey: 'done',
        ...(optionId ? { choice: { optionId } } : {}),
      }),
    );
  }

  it('a valid option writes `done` and returns the pick', async () => {
    const item = await createChoice(COMPLETE);
    expect(await decideWith(item.id, 'our-own-postgres')).toEqual({
      statusWritten: 'done',
      chosenOption: {
        optionId: 'our-own-postgres',
        label: 'Our own Postgres',
        bestFor: 'more cost-effective',
        followUp: 'The export story.',
        situation: 'better_than_your_decision',
      },
    });
    expect(await statusOf(item.id)).toBe('done');
  });

  it('an unknown option, or none, is a verb the gate does not offer, and writes nothing', async () => {
    // Not the stale refusal (MOTIR-5893): the door compares the stamp first, so the
    // options here are the ones the reader was shown — an id missing from them was
    // never offered.
    const item = await createChoice(COMPLETE);
    await expect(decideWith(item.id, 'a-cdn')).rejects.toBeInstanceOf(
      ApprovalGateVerbNotOfferedError,
    );
    await expect(decideWith(item.id, undefined)).rejects.toBeInstanceOf(
      ApprovalGateVerbNotOfferedError,
    );
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('None of these moves nothing', async () => {
    expect(await decisionChoiceGateHandler.requestChanges({} as never)).toEqual({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
  });
});

describe('the row summary — the question and how many options', () => {
  it('summarises a waiting choice from its body', async () => {
    const item = await createChoice(COMPLETE);
    const [gate] = await choiceGates(item.id);
    const summaries = await withWorkspaceContext(fx.ctx, (tx) =>
      summarizeGateSubjects([{ id: gate!.id, kind: gate!.kind, subjectId: gate!.subjectId }], tx),
    );
    expect(summaries.get(gate!.id)).toEqual({
      kind: 'decision_choice',
      optionCount: 2,
      question: 'Where do exported reports live?',
    });
  });
});
