import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE LATEST REFUSAL, OVER REAL STATE (Story MOTIR-6070 · Subtask MOTIR-6422; ADR
// `approval-gates.md` §10h note 4). Real Postgres through the ONE read,
// `approvalGatesService.latestRefusalFor`, and its two surfaces — the dispatched
// prompt's CHANGES REQUESTED section and `get_work_item`'s `latestRefusal`:
//
//   · it is the item's most recently DECIDED gate, of ANY kind, ordered by
//     `decidedAt` — kept only when that gate is `changes_requested`;
//   · a later approval answers null; an `awaiting` gate is not a decision and does not;
//   · it never crosses a workspace;
//   · a leg of a run launched against another item is handed its run target's too.

type Kind = 'design_result' | 'pull_request_approval' | 'acceptance_result';
type State = 'awaiting' | 'approved' | 'changes_requested';

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

async function gate(
  f: WorkItemFixture,
  workItemId: string,
  s: {
    state: State;
    kind?: Kind;
    decidedAt?: Date;
    createdAt?: Date;
    noteMd?: string | null;
    decisionSource?: 'ui' | 'api' | 'mcp' | 'github';
    refusalVerdict?: 'revise' | 're_plan' | null;
    subjectVersion?: string;
    decidedByLabel?: string;
  },
) {
  seq += 1;
  const decided = s.state !== 'awaiting';
  return adminDb.approvalGate.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      workItemId,
      kind: s.kind ?? 'design_result',
      subjectId: `subject-${seq}`,
      state: s.state,
      subjectVersion: s.subjectVersion ?? `version-${seq}`,
      noteMd: decided ? (s.noteMd === undefined ? `Reason ${seq}.` : s.noteMd) : null,
      decidedById: decided ? f.ctx.userId : null,
      decidedByLabel: decided ? (s.decidedByLabel ?? 'Ada L.') : null,
      decidedAt: decided ? (s.decidedAt ?? new Date()) : null,
      decisionSource: decided ? (s.decisionSource ?? 'ui') : null,
      refusalVerdict: s.refusalVerdict ?? null,
      ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    },
  });
}

const T1 = new Date('2026-09-20T09:00:00.000Z');
const T2 = new Date('2026-09-21T09:00:00.000Z');
const T3 = new Date('2026-09-22T09:00:00.000Z');

async function card(f: WorkItemFixture = fx) {
  return createTestWorkItem(f, { kind: 'task', type: 'design', title: 'Design it' });
}

async function promptFor(key: string, f: WorkItemFixture = fx) {
  return (await dispatchPromptService.getDispatchPrompt(f.projectId, key, f.ctx)).prompt;
}

describe('latestRefusalFor — the ordering over decisions', () => {
  it('refusal THEN approval → null: the approval answered it', async () => {
    const item = await card();
    await gate(fx, item.id, { state: 'changes_requested', decidedAt: T1 });
    await gate(fx, item.id, { state: 'approved', decidedAt: T2 });
    expect(await approvalGatesService.latestRefusalFor(item.id, fx.ctx)).toBeNull();
  });

  it('approval THEN refusal → the refusal, field for field', async () => {
    const item = await card();
    await gate(fx, item.id, { state: 'approved', decidedAt: T1 });
    const refused = await gate(fx, item.id, {
      state: 'changes_requested',
      decidedAt: T2,
      noteMd: 'The empty state is missing.',
      refusalVerdict: 'revise',
      subjectVersion: 'evidence-v2',
      decidedByLabel: 'Ada L. <ada@example.com>',
    });
    expect(await approvalGatesService.latestRefusalFor(item.id, fx.ctx)).toEqual({
      gateId: refused.id,
      kind: 'design_result',
      noteMd: 'The empty state is missing.',
      decidedByLabel: 'Ada L. <ada@example.com>',
      decidedAt: T2.toISOString(),
      decisionSource: 'ui',
      refusalVerdict: 'revise',
      subjectVersion: 'evidence-v2',
    });
  });

  it('two refusals → the LATER decision wins, even when it was CREATED first', async () => {
    const item = await card();
    const later = await gate(fx, item.id, {
      state: 'changes_requested',
      createdAt: T1,
      decidedAt: T3,
      noteMd: 'Second reason.',
    });
    await gate(fx, item.id, {
      state: 'changes_requested',
      createdAt: T2,
      decidedAt: T2,
      noteMd: 'First reason.',
    });
    const refusal = await approvalGatesService.latestRefusalFor(item.id, fx.ctx);
    expect(refusal?.gateId).toBe(later.id);
    expect(refusal?.noteMd).toBe('Second reason.');
  });

  it('an AWAITING gate after the refusal is not a decision — the refusal still stands', async () => {
    const item = await card();
    const refused = await gate(fx, item.id, { state: 'changes_requested', decidedAt: T1 });
    await gate(fx, item.id, { state: 'awaiting', createdAt: T2 });
    expect((await approvalGatesService.latestRefusalFor(item.id, fx.ctx))?.gateId).toBe(refused.id);
  });

  it('keys on ANY kind — an acceptance refusal after a design approval is the latest', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'A story' });
    await gate(fx, story.id, { state: 'approved', kind: 'design_result', decidedAt: T1 });
    await gate(fx, story.id, {
      state: 'changes_requested',
      kind: 'acceptance_result',
      decidedAt: T2,
    });
    expect((await approvalGatesService.latestRefusalFor(story.id, fx.ctx))?.kind).toBe(
      'acceptance_result',
    );
    // …and a later approval of a DIFFERENT kind still supersedes it.
    await gate(fx, story.id, { state: 'approved', kind: 'pull_request_approval', decidedAt: T3 });
    expect(await approvalGatesService.latestRefusalFor(story.id, fx.ctx)).toBeNull();
  });

  it('a card with no gate at all → null', async () => {
    const item = await card();
    expect(await approvalGatesService.latestRefusalFor(item.id, fx.ctx)).toBeNull();
  });

  it('never crosses a workspace — another tenant asking about this card gets null', async () => {
    const item = await card();
    await gate(fx, item.id, { state: 'changes_requested', decidedAt: T1 });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    expect(await approvalGatesService.latestRefusalFor(item.id, other.ctx)).toBeNull();
    // …and the owning tenant still sees it.
    expect(await approvalGatesService.latestRefusalFor(item.id, fx.ctx)).not.toBeNull();
  });
});

describe('the dispatched prompt', () => {
  it('a card whose latest decided gate is changes_requested carries the section', async () => {
    const item = await card();
    await gate(fx, item.id, {
      state: 'changes_requested',
      decidedAt: T1,
      noteMd: 'The empty state is missing.',
      refusalVerdict: 're_plan',
      subjectVersion: 'evidence-v1',
    });
    const prompt = await promptFor(item.identifier);
    expect(prompt).toContain('CHANGES REQUESTED — the last attempt was sent back, and why');
    expect(prompt).toContain(`  ${item.identifier} — its design_result gate was refused`);
    expect(prompt).toContain(`    by Ada L. in Motir, on ${T1.toISOString()}`);
    expect(prompt).toContain('    refused version: evidence-v1');
    expect(prompt).toContain('    verdict: Re-plan');
    expect(prompt).toContain('      The empty state is missing.');
    expect(prompt.indexOf('CHANGES REQUESTED')).toBeLessThan(prompt.indexOf('CARD DESCRIPTION'));
  });

  it('no decided gate, or an approval after the refusal → NO section', async () => {
    const fresh = await card();
    await gate(fx, fresh.id, { state: 'awaiting' });
    expect(await promptFor(fresh.identifier)).not.toContain('CHANGES REQUESTED');

    const answered = await card();
    await gate(fx, answered.id, { state: 'changes_requested', decidedAt: T1 });
    await gate(fx, answered.id, { state: 'approved', decidedAt: T2 });
    expect(await promptFor(answered.identifier)).not.toContain('CHANGES REQUESTED');
  });

  it('a GitHub refusal with a null note renders "no reason given on GitHub"', async () => {
    const item = await card();
    await gate(fx, item.id, {
      state: 'changes_requested',
      kind: 'pull_request_approval',
      decidedAt: T1,
      noteMd: null,
      decisionSource: 'github',
      decidedByLabel: 'octocat',
    });
    const prompt = await promptFor(item.identifier);
    expect(prompt).toContain('    by octocat in a GitHub review');
    expect(prompt).toContain('      (no reason given on GitHub)');
  });

  it('a leg of a run launched against its story is handed the STORY’s refusal too', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    const leg = await createTestWorkItem(fx, {
      kind: 'subtask',
      type: 'code',
      title: 'Child',
      parentId: story.id,
    });
    await gate(fx, story.id, {
      state: 'changes_requested',
      kind: 'acceptance_result',
      decidedAt: T1,
      noteMd: 'The video stops before the export finishes.',
    });
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId: story.id,
        cards: { create: { workspaceId: fx.workspaceId, workItemId: leg.id, position: 0 } },
      },
    });
    const prompt = await promptFor(leg.identifier);
    expect(prompt).toContain(`  ${story.identifier} — its acceptance_result gate was refused`);
    expect(prompt).toContain('      The video stops before the export finishes.');
  });
});

describe('get_work_item — latestRefusal', () => {
  it('a refused card carries the SAME object the service reads', async () => {
    const item = await card();
    await gate(fx, item.id, {
      state: 'changes_requested',
      decidedAt: T1,
      refusalVerdict: 'revise',
    });
    const expected = await approvalGatesService.latestRefusalFor(item.id, fx.ctx);
    const result = await runGetWorkItem({ key: item.identifier }, fx.ctx);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { latestRefusal: unknown };
    expect(expected).not.toBeNull();
    expect(structured.latestRefusal).toEqual(expected);
  });

  it('a card never refused, or approved after a refusal, carries latestRefusal: null', async () => {
    const fresh = await card();
    const r1 = await runGetWorkItem({ key: fresh.identifier }, fx.ctx);
    expect((r1.structuredContent as { latestRefusal: unknown }).latestRefusal).toBeNull();

    const answered = await card();
    await gate(fx, answered.id, { state: 'changes_requested', decidedAt: T1 });
    await gate(fx, answered.id, { state: 'approved', decidedAt: T2 });
    const r2 = await runGetWorkItem({ key: answered.identifier }, fx.ctx);
    expect((r2.structuredContent as { latestRefusal: unknown }).latestRefusal).toBeNull();
  });
});
