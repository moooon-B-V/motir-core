import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client, the external boundary. Everything else
// is real — Postgres, `plansService`'s transactions, the internal routes and
// their job-token auth.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ProposalInput, ProposalLanguages } from '@/lib/dto/plans';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { PATCH as itemPATCH } from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-7734 · MOTIR-8743 — a proposal carries the language each of its
// text fields was WRITTEN in, from generation to approval, and approval records
// THAT. The organisation's setting is read at approve only for a field whose
// proposal names no language, so changing the setting between generation and
// approval changes nothing a planner stated.

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function fixtureIn(language: string): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  await setOrgLanguage(fx, language);
  return fx;
}

async function setOrgLanguage(fx: WorkItemFixture, language: string): Promise<void> {
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage: language },
  });
}

function withToken(fx: WorkItemFixture, req: Request): Request {
  req.headers.set(
    'x-motir-job-token',
    mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  );
  return req;
}

function append(fx: WorkItemFixture, jobId: string, proposals: unknown[]): Promise<Response> {
  return proposalsPOST(
    withToken(
      fx,
      new Request('http://core/api/internal/ai/plan-proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
        body: JSON.stringify({ jobId, proposals }),
      }),
    ),
  );
}

function deepen(
  fx: WorkItemFixture,
  jobId: string,
  itemId: string,
  patch: unknown,
): Promise<Response> {
  return itemPATCH(
    withToken(
      fx,
      new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
        body: JSON.stringify({ jobId, patch }),
      }),
    ),
    { params: Promise.resolve({ itemId }) },
  );
}

/** A `generating` plan bound to `jobId`, the state motir-ai's writes land in. */
async function generatingPlan(fx: WorkItemFixture, jobId: string): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Generated', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return plan.id;
}

async function appendOk(fx: WorkItemFixture, jobId: string, proposals: unknown[]) {
  const res = await append(fx, jobId, proposals);
  expect(res.status).toBe(200);
  return (await res.json()) as { planItemIds: string[] };
}

async function approvePlan(fx: WorkItemFixture, planId: string): Promise<void> {
  await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
}

async function approve(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<void> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await approvePlan(fx, plan.id);
}

async function storedLanguages(itemId: string): Promise<ProposalLanguages | undefined> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
  return (row.proposedFields as { languages?: ProposalLanguages }).languages;
}

const languagesOf = (row: {
  titleLanguage: string | null;
  descriptionLanguage: string | null;
  explanationLanguage: string | null;
}) => [row.titleLanguage, row.descriptionLanguage, row.explanationLanguage];

async function item(title: string) {
  return adminDb.workItem.findFirstOrThrow({ where: { title } });
}

async function stepsOf(workItemId: string) {
  const rows = await adminDb.workItemTodo.findMany({
    where: { workItemId },
    orderBy: { position: 'asc' },
  });
  return rows.map((t) => [t.textLanguage, t.notesLanguage]);
}

describe('an add records the language its proposal names', () => {
  it('records each field’s stated language in an `en` organisation, steps and notes included', async () => {
    const fx = await fixtureIn('en');
    const planId = await generatingPlan(fx, 'job-add');
    await appendOk(fx, 'job-add', [
      {
        op: 'add',
        proposedFields: {
          title: '导出报表',
          kind: 'task',
          descriptionMd: '使用导出服务。',
          explanationMd: '매주 필요합니다.',
          todos: [{ text: '添加按钮', notesMd: '在工具栏。' }, { text: '写测试' }],
        },
        languages: { title: 'zh', description: 'zh', todos: 'zh', explanation: 'ko' },
      },
    ]);
    await approvePlan(fx, planId);

    const created = await item('导出报表');
    expect(languagesOf(created)).toEqual(['zh', 'zh', 'ko']);
    expect(await stepsOf(created.id)).toEqual([
      ['zh', 'zh'],
      ['zh', null],
    ]);
  });

  it('a body with no text records NULL even when its language is stated', async () => {
    const fx = await fixtureIn('en');
    await approve(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Titled only', kind: 'task' },
        languages: { title: 'zh', description: 'zh', explanation: 'ko' },
      },
    ]);
    expect(languagesOf(await item('Titled only'))).toEqual(['zh', null, null]);
  });

  it('a setting changed between generation and approval changes only the fields with no statement', async () => {
    const fx = await fixtureIn('en');
    const planId = await generatingPlan(fx, 'job-switch');
    await appendOk(fx, 'job-switch', [
      {
        op: 'add',
        proposedFields: {
          title: 'Stated',
          kind: 'task',
          descriptionMd: 'Written in English.',
          explanationMd: 'No statement for this one.',
        },
        languages: { title: 'en', description: 'en' },
      },
      { op: 'add', proposedFields: { title: 'Unstated', kind: 'task' } },
    ]);
    await setOrgLanguage(fx, 'ja');
    await approvePlan(fx, planId);

    expect(languagesOf(await item('Stated'))).toEqual(['en', 'en', 'ja']);
    expect((await item('Unstated')).titleLanguage).toBe('ja');
  });

  it('the intra-plan ref rewrite at approve changes no recorded language', async () => {
    const fx = await fixtureIn('ko');
    const planId = await generatingPlan(fx, 'job-refs');
    const [bId] = (
      await appendOk(fx, 'job-refs', [
        { op: 'add', proposedFields: { title: 'Sibling B', kind: 'task' } },
      ])
    ).planItemIds;
    await appendOk(fx, 'job-refs', [
      {
        op: 'add',
        proposedFields: {
          title: 'Card A',
          kind: 'task',
          descriptionMd: `依赖 [Sibling B](motir-ref:planItem:${bId}).`,
        },
        languages: { title: 'zh', description: 'zh' },
      },
    ]);
    await approvePlan(fx, planId);

    const a = await item('Card A');
    expect(a.descriptionMd).toContain('](motir:');
    expect(languagesOf(a)).toEqual(['zh', 'zh', null]);
  });
});

describe('an edit keeps or drops the statement per field', () => {
  it('a deepen replaces only the keys it names, and one that rewrites text without a language drops that key', async () => {
    const fx = await fixtureIn('en');
    await generatingPlan(fx, 'job-deepen');
    const [id] = (
      await appendOk(fx, 'job-deepen', [
        {
          op: 'add',
          proposedFields: {
            title: '标题',
            kind: 'task',
            descriptionMd: '旧',
            explanationMd: '이유',
          },
          languages: { title: 'zh', description: 'zh', explanation: 'ko' },
        },
      ])
    ).planItemIds;

    const first = await deepen(fx, 'job-deepen', id!, {
      descriptionMd: 'Neu geschrieben.',
      languages: { description: 'de' },
    });
    expect(first.status).toBe(200);
    expect(await storedLanguages(id!)).toEqual({
      title: 'zh',
      description: 'de',
      explanation: 'ko',
    });

    const second = await deepen(fx, 'job-deepen', id!, { explanationMd: 'Rewritten, unstated.' });
    expect(second.status).toBe(200);
    expect(await storedLanguages(id!)).toEqual({ title: 'zh', description: 'de' });
  });

  it('the public review edit (no language) of a title drops `languages.title`, so approve records the setting', async () => {
    const fx = await fixtureIn('ja');
    const planId = await generatingPlan(fx, 'job-review');
    const [id] = (
      await appendOk(fx, 'job-review', [
        {
          op: 'add',
          proposedFields: { title: '原标题', kind: 'task', descriptionMd: '正文' },
          languages: { title: 'zh', description: 'zh' },
        },
      ])
    ).planItemIds;
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.updateProposal(planId, id!, { title: 'Edited by a person' }, fx.ctx);
    expect(await storedLanguages(id!)).toEqual({ description: 'zh' });

    await plansService.approvePlan(planId, fx.ctx);
    expect(languagesOf(await item('Edited by a person'))).toEqual(['ja', 'zh', null]);
  });
});

describe('a modify records the language of each field it changes', () => {
  async function target(fx: WorkItemFixture) {
    return workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Old title',
        descriptionMd: 'Old body',
        languages: { title: 'fr', description: 'fr' },
      },
      fx.ctx,
    );
  }

  it('a stated description in a `ja` organisation records `de` there and leaves the title alone', async () => {
    const fx = await fixtureIn('ja');
    const t = await target(fx);
    await approve(fx, [
      {
        op: 'modify',
        workItemId: t.id,
        patch: { descriptionMd: 'Neuer Text', languages: { description: 'de' } },
      },
    ]);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: t.id } });
    expect(languagesOf(row)).toEqual(['fr', 'de', null]);
  });

  it('a patch that sets only a stated title records only the title', async () => {
    const fx = await fixtureIn('ja');
    const t = await target(fx);
    await approve(fx, [
      { op: 'modify', workItemId: t.id, patch: { title: '새 제목', languages: { title: 'ko' } } },
    ]);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: t.id } });
    expect(languagesOf(row)).toEqual(['ko', 'fr', null]);
  });

  it('replaced steps record `languages.todos`', async () => {
    const fx = await fixtureIn('ja');
    const t = await target(fx);
    await approve(fx, [
      {
        op: 'modify',
        workItemId: t.id,
        patch: {
          todos: [{ text: '第一步', notesMd: '备注' }, { text: '第二步' }],
          languages: { todos: 'zh' },
        },
      },
    ]);
    expect(await stepsOf(t.id)).toEqual([
      ['zh', 'zh'],
      ['zh', null],
    ]);
  });
});

describe('a malformed statement is refused where it is written', () => {
  const BAD: Array<[string, unknown]> = [
    ['a key outside the four', { summary: 'zh' }],
    ['a value outside the eleven locales', { title: 'xx' }],
    ['a non-object', 'zh'],
  ];

  for (const [label, languages] of BAD) {
    it(`the append refuses ${label} with a 422 naming the proposal`, async () => {
      const fx = await fixtureIn('en');
      await generatingPlan(fx, 'job-bad-append');
      const res = await append(fx, 'job-bad-append', [
        { op: 'add', proposedFields: { title: 'Badly stated', kind: 'task' }, languages },
      ]);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('INVALID_PROPOSAL');
      expect(body.error).toContain('Badly stated');
    });

    it(`the deepen refuses ${label} with a 422 naming the proposal`, async () => {
      const fx = await fixtureIn('en');
      await generatingPlan(fx, 'job-bad-deepen');
      const [id] = (
        await appendOk(fx, 'job-bad-deepen', [
          { op: 'add', proposedFields: { title: 'Deepened badly', kind: 'task' } },
        ])
      ).planItemIds;
      const res = await deepen(fx, 'job-bad-deepen', id!, { descriptionMd: 'x', languages });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('INVALID_PROPOSAL');
      expect(body.error).toContain('Deepened badly');
    });
  }
});
