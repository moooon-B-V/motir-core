import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import { decisionChoiceGateHandler } from '@/lib/approvalGates/decisionChoiceHandler';
import { ApprovalGateStaleSubjectError } from '@/lib/approvalGates/errors';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { choiceGateService } from '@/lib/services/choiceGateService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CHOICE SURFACE'S EDGES (Story MOTIR-4914 · Subtask MOTIR-5898) — the branches the
// per-subtask suites left: the parser's malformed shapes, the handler on a subject that
// is not (or no longer) a choice, the raise under an OPEN workflow and under one with no
// path to review, and the *None of these* rule that the unchanged options are not asked
// again. Real Postgres, through the real service funnels.

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

const BODY = [
  '## Question',
  'Which invoice numbering?',
  '## Why this is a choice',
  '**Situation:** two workflows',
  'Finance and sales each describe a different sequence.',
  '## Options',
  '### Per year',
  '**Best if you want:** less to operate',
  'Resets every January.',
  '### Continuous',
  '**Best if you want:** more customisable later',
  'Never resets.',
  '## What this choice gates',
  'The invoicing story.',
].join('\n');

async function createItem(descriptionMd: string, type: 'choice' | 'decision' = 'choice') {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Item ${seq}`,
      type,
      executor: 'human',
      descriptionMd,
    },
    fx.ctx,
  );
}

const choiceGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'decision_choice' },
    orderBy: { createdAt: 'asc' },
  });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('the parser on malformed shapes', () => {
  it('an empty heading, a repeated section, an empty quote and an unlabelled option', () => {
    const md = [
      '## ',
      'stray',
      '## Why this is a choice',
      '**Situation:** better than your decision',
      '**You said:** ""',
      'Evidence.',
      '## Options',
      '### ',
      'no label',
      '### A',
      '**Best if you want:** x',
      '### B',
      '**Best if you want:** y',
      '## Options',
      '### Ignored',
      '## What this choice gates',
      'Next.',
    ].join('\n');
    const parse = parseChoiceOptions(md);
    // An empty quote is no quote: a debated decision must be QUOTED.
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.defects).toEqual([{ reason: 'no_quoted_decision' }]);
    // The first `## Options` wins; the unlabelled `###` is skipped; no `## Question`.
    expect(parse.draft.options.map((o) => o.label)).toEqual(['A', 'B']);
    expect(parse.draft.question).toBe('');
  });

  it('a complete body with no Question section still parses, with an empty question', () => {
    const parse = parseChoiceOptions(BODY.replace('## Question\nWhich invoice numbering?\n', ''));
    expect(parse.ok && parse.question).toBe('');
  });
});

describe('the handler on a subject that is not a choice', () => {
  it('resolves nothing, stamps nothing, and has no current subject', async () => {
    const decision = await createItem(BODY, 'decision');
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: decision.id } });
    const args = {
      gate: {
        id: 'g',
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: row.id,
        subjectId: row.id,
      },
      item: row,
      ctx: fx.ctx,
      resolvedStatusKey: 'done',
      refusalVerdict: null,
    };
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await decisionChoiceGateHandler.resolveSubject({ ...args, tx })).toBeNull();
      expect(await decisionChoiceGateHandler.subjectVersion({ ...args, tx })).toBeNull();
      expect(
        await decisionChoiceGateHandler.currentSubject({ item: row, ctx: fx.ctx, tx }),
      ).toBeNull();
    });
  });

  it('a choice whose body stopped parsing has no current subject, and choosing on it is stale', async () => {
    const item = await createItem(BODY);
    const [gate] = await choiceGates(item.id);
    // Written behind the service's back, so the gate is still awaiting over a broken body.
    await adminDb.workItem.update({ where: { id: item.id }, data: { descriptionMd: 'broken' } });
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await decisionChoiceGateHandler.currentSubject({ item: row, ctx: fx.ctx, tx }),
      ).toBeNull();
      await expect(
        decisionChoiceGateHandler.approve({
          gate: {
            id: gate!.id,
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: item.id,
            subjectId: item.id,
          },
          item: row,
          ctx: fx.ctx,
          tx,
          resolvedStatusKey: 'done',
          refusalVerdict: null,
          choice: { optionId: 'per-year' },
        }),
      ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);
    });
    expect(await choiceGateService.readPort(item.id, fx.ctx)).toBeNull();
  });

  it('a project with no done-category status records the pick and defers the status', async () => {
    const item = await createItem(BODY);
    const [gate] = await choiceGates(item.id);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    const effect = await withWorkspaceContext(fx.ctx, (tx) =>
      decisionChoiceGateHandler.approve({
        gate: {
          id: gate!.id,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          subjectId: item.id,
        },
        item: row,
        ctx: fx.ctx,
        tx,
        resolvedStatusKey: null,
        refusalVerdict: null,
        choice: { optionId: 'continuous' },
      }),
    );
    expect(effect).toMatchObject({
      statusWritten: null,
      statusDeferredReason: 'no_status_in_target_category',
      chosenOption: { optionId: 'continuous' },
    });
  });
});

describe('the raise under different workflows', () => {
  it('an OPEN workflow walks straight to review', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { workflowPolicyMode: 'open' },
    });
    const item = await createItem(BODY);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a workflow with NO declared path to review keeps the status, and the question still stands', async () => {
    const review = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: fx.projectId, key: 'in_review' },
    });
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: fx.projectId, toStatusId: review.id },
    });
    const item = await createItem(BODY);
    expect((await choiceGates(item.id)).map((g) => g.state)).toEqual(['awaiting']);
    expect(await statusOf(item.id)).not.toBe('in_review');
  });
});

describe('re-asking', () => {
  it('None of these is not asked again until the options change', async () => {
    const item = await createItem(BODY);
    const [gate] = await choiceGates(item.id);
    await approvalGatesService.decide(
      {
        gateId: gate!.id,
        decision: 'request_changes',
        noteMd: 'Needs changes.',
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );
    // Rewording the question leaves the stamp — the same options are not re-asked.
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: BODY.replace('Which invoice', 'What invoice') },
      fx.ctx,
    );
    expect((await choiceGates(item.id)).map((g) => g.state)).toEqual(['changes_requested']);
    // Revising the options is what asks again.
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: BODY.replace('Never resets.', 'Never resets; one sequence.') },
      fx.ctx,
    );
    expect((await choiceGates(item.id)).map((g) => g.state)).toEqual([
      'changes_requested',
      'awaiting',
    ]);
  });

  it('a defective choice changed to another type withdraws nothing — there was nothing asked', async () => {
    const item = await createItem('broken');
    await workItemsService.updateWorkItem(item.id, { type: 'decision' }, fx.ctx);
    expect(await choiceGates(item.id)).toHaveLength(0);
  });

  it('reads nothing for a work item this workspace cannot see', async () => {
    expect(await choiceGateService.readBody('no-such-item', fx.ctx)).toBeNull();
  });
});
