import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Story MOTIR-7734 · MOTIR-8744 — a drafted explanation is SAVED with the
// language it was drafted in, through the two issue actions, on a REAL Postgres
// through the real service. Only the session and the active project are stubbed.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { db } from '@/lib/db';
import { createIssueAction } from '@/app/(authed)/items/actions';
import { updateIssueAction } from '@/app/(authed)/items/[key]/edit/actions';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function fixtureIn(language: string): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage: language },
  });
  session.current = { user: { id: fx.ctx.userId } };
  activeCtx.current = {
    projectId: fx.projectId,
    userId: fx.ctx.userId,
    workspaceId: fx.workspaceId,
  };
  return fx;
}

const columns = (row: {
  titleLanguage: string | null;
  descriptionLanguage: string | null;
  explanationLanguage: string | null;
}) => [row.titleLanguage, row.descriptionLanguage, row.explanationLanguage];

async function create(input: Parameters<typeof createIssueAction>[0]) {
  const res = await createIssueAction(input);
  expect(res.ok).toBe(true);
  return adminDb.workItem.findFirstOrThrow({ where: { title: input.title } });
}

describe('createIssueAction records the drafted explanation’s language', () => {
  it('a Korean draft in an `en` organisation records `ko` on the explanation only', async () => {
    await fixtureIn('en');
    const row = await create({
      kind: 'task',
      title: 'Export the report',
      descriptionMd: 'Use the export service.',
      explanationMd: '매주 필요합니다.',
      explanationSource: 'ai_draft',
      languages: { explanation: 'ko' },
    });
    expect(columns(row)).toEqual(['en', 'en', 'ko']);
  });

  it('a no-person draft whose frame carried the content language records it', async () => {
    await fixtureIn('en');
    const row = await create({
      kind: 'task',
      title: 'No person',
      explanationMd: '每周都需要。',
      languages: { explanation: 'zh' },
    });
    expect(row.explanationLanguage).toBe('zh');
  });

  it('a hand-typed explanation sends no language and records the organisation’s', async () => {
    await fixtureIn('ja');
    const row = await create({ kind: 'task', title: 'Hand typed', explanationMd: 'Typed.' });
    expect(row.explanationLanguage).toBe('ja');
  });

  it('drops a forged title or description language, and an unknown code', async () => {
    await fixtureIn('en');
    const forged = await create({
      kind: 'task',
      title: 'Forged',
      descriptionMd: 'Body',
      explanationMd: 'Why',
      languages: { explanation: 'ko', title: 'ja', description: 'de' } as { explanation: 'ko' },
    });
    expect(columns(forged)).toEqual(['en', 'en', 'ko']);

    const unknown = await create({
      kind: 'task',
      title: 'Unknown code',
      explanationMd: 'Why',
      languages: { explanation: 'xx' } as unknown as { explanation: 'ko' },
    });
    expect(unknown.explanationLanguage).toBe('en');
  });

  it('a draft cleared to empty records no explanation and no language', async () => {
    await fixtureIn('en');
    const row = await create({
      kind: 'task',
      title: 'Cleared',
      explanationMd: null,
      languages: { explanation: 'ko' },
    });
    expect(row.explanationMd).toBeNull();
    expect(row.explanationLanguage).toBeNull();
  });
});

describe('updateIssueAction records the drafted explanation’s language', () => {
  it('records `ko` on the explanation and leaves the title and description columns alone', async () => {
    const fx = await fixtureIn('en');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Existing',
        descriptionMd: 'Body',
        languages: { title: 'fr', description: 'fr' },
      },
      fx.ctx,
    );
    const res = await updateIssueAction({
      id: item.id,
      title: 'Existing',
      descriptionMd: 'Body',
      explanationMd: '매주 필요합니다.',
      explanationSource: 'ai_draft',
      languages: { explanation: 'ko' },
    });
    expect(res.ok).toBe(true);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(columns(row)).toEqual(['fr', 'fr', 'ko']);
  });
});
