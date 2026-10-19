import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { renderSections } from '@/lib/workItems/sections/render';
import { parseSections } from '@/lib/workItems/sections/parse';
import { makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import { fixture as sectionsFixture } from '../../unit/workItems/sections/helpers/sectionFixture';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-9023 · MOTIR-9033 — `get_work_item` with `includeSections` parses
// the body it already read, at read time. Real Postgres. Unasked, the answer
// carries no `parsedSections` and no `Sections:` line; asked, the view equals the
// parser's own result for the stored body, and the body and `updatedAt` never move.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const structured = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function seed() {
  const fx = await makeWorkItemFixture();
  const mk = (title: string, descriptionMd: string) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', type: 'code', title, descriptionMd },
      fx.ctx,
    );
  const headed = await mk(
    'Headed',
    renderSections('task', 'code', sectionsFixture('task', 'code')),
  );
  const plain = await mk('Plain', 'Just a paragraph, no headings at all.');
  const gutter = await mk(
    'Gutter',
    renderSections('task', 'code', sectionsFixture('task', 'code'))
      .split('\n')
      .map((l) => (l === '' ? l : `| ${l}`))
      .join('\n'),
  );
  return { fx, headed, plain, gutter };
}

describe('get_work_item includeSections (MOTIR-9033)', () => {
  it('an unasked read carries no parsedSections and no Sections: line', async () => {
    const { fx, plain } = await seed();
    for (const args of [
      { key: plain.identifier },
      { key: plain.identifier, includeSections: false },
    ]) {
      const res = await runGetWorkItem(args, fx.ctx);
      expect(structured(res)).not.toHaveProperty('parsedSections');
      expect(text(res)).not.toContain('Sections:');
    }
  });

  it('an asked read returns the parser’s own result for each stored body', async () => {
    const { fx, headed, plain, gutter } = await seed();
    for (const card of [headed, plain, gutter]) {
      const res = await runGetWorkItem({ key: card.identifier, includeSections: true }, fx.ctx);
      const stored = (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } }))
        .descriptionMd;
      expect(structured(res).parsedSections).toEqual(parseSections(stored, 'task', 'code'));
      expect(text(res)).toMatch(/^Sections: found /m);
    }

    const plainView = structured(
      await runGetWorkItem({ key: plain.identifier, includeSections: true }, fx.ctx),
    ).parsedSections as ReturnType<typeof parseSections>;
    expect(plainView.missing).toEqual(
      expect.arrayContaining(['scopeBoundary', 'acceptanceCriteria', 'contextRefs']),
    );
    expect(plainView.signals).toContain('no-headings');
    expect(plainView.sections.framing).toBe('Just a paragraph, no headings at all.');

    const gutterView = structured(
      await runGetWorkItem({ key: gutter.identifier, includeSections: true }, fx.ctx),
    ).parsedSections as ReturnType<typeof parseSections>;
    expect(gutterView.signals).toContain('quoted-gutter');
    expect(gutterView.missing).toEqual(
      expect.arrayContaining(['scopeBoundary', 'acceptanceCriteria']),
    );
    const headedView = structured(
      await runGetWorkItem({ key: headed.identifier, includeSections: true }, fx.ctx),
    ).parsedSections as ReturnType<typeof parseSections>;
    expect(headedView.missing).toEqual([]);
  });

  it('returns the body byte-identical and never touches the row, flag or not', async () => {
    const { fx, gutter } = await seed();
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: gutter.id } });
    for (const includeSections of [false, true]) {
      const res = await runGetWorkItem({ key: gutter.identifier, includeSections }, fx.ctx);
      expect((structured(res).item as { descriptionMd: string }).descriptionMd).toBe(
        before.descriptionMd,
      );
      expect(text(res)).toContain(before.descriptionMd as string);
      const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: gutter.id } });
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.descriptionMd).toBe(before.descriptionMd);
    }
  });

  it('with a planId, parses the projected target’s own body, kind and type', async () => {
    const { fx, plain } = await seed();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    const proposed = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Proposed',
            kind: 'task',
            type: 'code',
            descriptionMd: 'Plain proposal body.',
          },
        },
        {
          op: 'modify',
          workItemId: plain.id,
          patch: {
            descriptionMd: renderSections('task', 'code', sectionsFixture('task', 'code')),
          },
        },
      ],
      fx.ctx,
    );
    const add = proposed.items.find((i) => i.op === 'add')!;

    const addView = await runGetWorkItem(
      { key: `planItem:${add.id}`, planId: plan.id, includeSections: true },
      fx.ctx,
    );
    expect(structured(addView).parsedSections).toEqual(
      parseSections('Plain proposal body.', 'task', 'code'),
    );
    const modifyView = await runGetWorkItem(
      { key: plain.identifier, planId: plan.id, includeSections: true },
      fx.ctx,
    );
    expect((structured(modifyView).parsedSections as { missing: string[] }).missing).toEqual([]);

    const unasked = await runGetWorkItem({ key: plain.identifier, planId: plan.id }, fx.ctx);
    expect(structured(unasked)).not.toHaveProperty('parsedSections');
  });
});
