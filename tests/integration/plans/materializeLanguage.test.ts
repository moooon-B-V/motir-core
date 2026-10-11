import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemProposedFields } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-7731 · MOTIR-8097 — plan approval records the language of the
// text it writes. `materialize` builds its inserts by hand (one transaction, no
// `createWorkItem`), so it records the organisation's content language itself:
// on the title always, on a body only when it holds text, and on each step's
// text and notes. Pass 3's temp-ref rewrite is not an edit and leaves every
// column as Pass 1 wrote it; a `modify` re-records only the fields it changed.
// Real Postgres.

beforeEach(async () => {
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
  return fx;
}

async function approve(
  fx: WorkItemFixture,
  proposals: Parameters<typeof plansService.addProposals>[1],
): Promise<void> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
}

const languagesOf = (row: {
  titleLanguage: string | null;
  descriptionLanguage: string | null;
  explanationLanguage: string | null;
}) => [row.titleLanguage, row.descriptionLanguage, row.explanationLanguage];

describe('materialize — an approved add records the organisation language', () => {
  it('records it on the title, both bodies and each step, and NULL on a step with no notes', async () => {
    const fx = await fixtureIn('ja');
    const fields: PlanItemProposedFields = {
      title: 'リリースを切る',
      kind: 'task',
      descriptionMd: 'リリーススクリプトを使う。',
      explanationMd: '毎週のリリースに必要。',
      todos: [{ text: 'ビルドにタグを付ける', notesMd: 'スクリプトで。' }, { text: '告知する' }],
    };
    await approve(fx, [{ op: 'add', proposedFields: fields }]);

    const item = await adminDb.workItem.findFirstOrThrow({ where: { title: fields.title } });
    expect(languagesOf(item)).toEqual(['ja', 'ja', 'ja']);
    const todos = await adminDb.workItemTodo.findMany({
      where: { workItemId: item.id },
      orderBy: { position: 'asc' },
    });
    expect(todos.map((t) => [t.textLanguage, t.notesLanguage])).toEqual([
      ['ja', 'ja'],
      ['ja', null],
    ]);
  });

  it('records NULL on an absent explanation', async () => {
    const fx = await fixtureIn('ja');
    await approve(fx, [
      {
        op: 'add',
        proposedFields: { title: 'No explanation', kind: 'task', descriptionMd: '本文' },
      },
    ]);
    const item = await adminDb.workItem.findFirstOrThrow({ where: { title: 'No explanation' } });
    expect(languagesOf(item)).toEqual(['ja', 'ja', null]);
  });

  it('leaves every language column as written when Pass 3 rewrites an intra-plan ref', async () => {
    const fx = await fixtureIn('ko');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Tree' }, fx.ctx);
    const afterB = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Sibling B', kind: 'task' } }],
      fx.ctx,
    );
    const bPlanItemId = afterB.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Card A',
            kind: 'task',
            descriptionMd: `Depends on [Sibling B](motir-ref:planItem:${bPlanItemId}).`,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const a = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Card A' } });
    const b = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Sibling B' } });
    // The rewrite happened…
    expect(a.descriptionMd).toBe(`Depends on [Sibling B](motir:${b.id}).`);
    // …and changed no recorded language.
    expect(languagesOf(a)).toEqual(['ko', 'ko', null]);
  });
});

describe('materialize — a modify re-records only the fields it changed', () => {
  it('records the org language on a changed description and leaves the untouched title alone', async () => {
    const fx = await fixtureIn('de');
    const target = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Old title',
        descriptionMd: 'Old body',
        explanationMd: 'Why',
        languages: { title: 'fr', description: 'fr', explanation: 'fr' },
      },
      fx.ctx,
    );

    await approve(fx, [
      {
        op: 'modify',
        workItemId: target.id,
        // `title` is re-stated unchanged; only the description is new.
        patch: { title: 'Old title', descriptionMd: 'Neuer Text' },
      },
    ]);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.descriptionMd).toBe('Neuer Text');
    expect(languagesOf(row)).toEqual(['fr', 'de', 'fr']);
  });

  it('records NULL on a body the modify empties', async () => {
    const fx = await fixtureIn('de');
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'T', explanationMd: 'Why', language: 'fr' },
      fx.ctx,
    );
    await approve(fx, [{ op: 'modify', workItemId: target.id, patch: { explanationMd: '' } }]);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.explanationLanguage).toBeNull();
    expect(row.titleLanguage).toBe('fr');
  });
});
